use std::collections::BTreeSet;
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use tantivy::collector::{Count, TopDocs};
use tantivy::directory::MmapDirectory;
use tantivy::query::{BooleanQuery, Query, QueryParser, RangeQuery, TermQuery};
use tantivy::schema::{TantivyDocument, Value};
use tantivy::tokenizer::{LowerCaser, NgramTokenizer, TextAnalyzer};
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, Term};

use super::elastic::ElasticRuntime;
use super::schema::{build_schema, SearchFields};
use crate::models::{SearchBackendStatus, SearchFilters, SearchScope};

#[derive(Debug, Clone, Serialize)]
pub struct SearchDocument {
    pub file_id: i64,
    pub folder_id: i64,
    pub file_name: String,
    pub content: String,
    pub title: String,
    pub author: String,
    pub keywords: String,
    pub extension: String,
    pub modified_at: String,
    pub size_bytes: i64,
}

#[derive(Debug, Clone)]
pub struct SearchHit {
    pub file_id: i64,
    pub score: f32,
}

#[derive(Debug, Clone)]
pub struct SearchPage {
    pub hits: Vec<SearchHit>,
    pub total: u64,
}

const ELASTIC_SYNC_MARKER_VERSION: &str = "2";

#[derive(Default)]
struct PendingElasticSync {
    active: bool,
    files: BTreeSet<i64>,
    folders: BTreeSet<i64>,
}

pub struct SearchEngine {
    index: Index,
    reader: IndexReader,
    writer: Mutex<IndexWriter>,
    fields: SearchFields,
    elastic: ElasticRuntime,
    elastic_sync_marker: PathBuf,
    elastic_sync_generation: Mutex<u64>,
    pending_elastic: Mutex<PendingElasticSync>,
    elastic_search_enabled: AtomicBool,
}

impl SearchEngine {
    pub fn open(path: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
        let (schema, fields) = build_schema();
        let directory = MmapDirectory::open(path).map_err(|e| e.to_string())?;
        let index = match Index::open_or_create(directory, schema.clone()) {
            Ok(index) => index,
            Err(tantivy::TantivyError::SchemaError(_)) => {
                log::warn!("Search index schema changed; rebuilding the derived index");
                std::fs::remove_dir_all(path).map_err(|e| e.to_string())?;
                std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
                let directory = MmapDirectory::open(path).map_err(|e| e.to_string())?;
                Index::open_or_create(directory, schema).map_err(|e| e.to_string())?
            }
            Err(error) => return Err(error.to_string()),
        };
        let analyzer =
            TextAnalyzer::builder(NgramTokenizer::new(1, 3, false).map_err(|e| e.to_string())?)
                .filter(LowerCaser)
                .build();
        index.tokenizers().register("xd_text", analyzer);
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()
            .map_err(|e| e.to_string())?;
        let writer = index.writer(50_000_000).map_err(|e| e.to_string())?;
        Ok(Self {
            index,
            reader,
            writer: Mutex::new(writer),
            fields,
            elastic: ElasticRuntime::new()?,
            elastic_sync_marker: path.join("elasticsearch-sync-v2"),
            elastic_sync_generation: Mutex::new(0),
            pending_elastic: Mutex::new(PendingElasticSync::default()),
            elastic_search_enabled: AtomicBool::new(true),
        })
    }

    pub fn configure_elasticsearch(
        &self,
        distribution_dir: PathBuf,
        data_dir: PathBuf,
        logs_dir: PathBuf,
    ) {
        self.elastic.configure(distribution_dir, data_dir, logs_dir);
    }

    pub fn start_elasticsearch(&self) -> Result<(), String> {
        self.elastic.start()
    }

    pub fn backend_status(&self) -> SearchBackendStatus {
        let mut status = self.elastic.status();
        if !self.elastic_search_enabled.load(Ordering::Acquire) {
            status.connected = false;
            status.backend = "tantivy-fallback".into();
        }
        status
    }

    pub fn prepare_background_sync(&self) {
        let mut pending = self.pending_elastic.lock().unwrap();
        pending.active = true;
        self.elastic_search_enabled.store(false, Ordering::Release);
    }

    pub fn finish_background_sync_failed(&self) {
        let mut pending = self.pending_elastic.lock().unwrap();
        pending.active = false;
        pending.files.clear();
        pending.folders.clear();
        self.elastic_search_enabled.store(false, Ordering::Release);
        self.elastic.deactivate();
    }

    pub fn is_empty(&self) -> bool {
        self.reader.searcher().num_docs() == 0
    }

    pub fn upsert(&self, mut document: SearchDocument) -> Result<(), String> {
        document.content = normalize_cjk_ocr_spacing(&document.content);
        self.apply_changes(&[document], &[])
    }

    pub fn apply_changes(
        &self,
        documents: &[SearchDocument],
        deleted_file_ids: &[i64],
    ) -> Result<(), String> {
        if documents.is_empty() && deleted_file_ids.is_empty() {
            return Ok(());
        }
        let mut pending = self.pending_elastic.lock().map_err(|e| e.to_string())?;
        let sync_generation = self.mark_elasticsearch_dirty();
        {
            let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
            for file_id in deleted_file_ids {
                writer.delete_term(Term::from_field_i64(self.fields.file_id, *file_id));
            }
            for document in documents {
                writer.delete_term(Term::from_field_i64(self.fields.file_id, document.file_id));
                writer
                    .add_document(self.to_document(document.clone()))
                    .map_err(|e| e.to_string())?;
            }
            writer.commit().map_err(|e| e.to_string())?;
            self.reader.reload().map_err(|e| e.to_string())?;
        }
        if pending.active {
            pending.files.extend(documents.iter().map(|d| d.file_id));
            pending.files.extend(deleted_file_ids.iter().copied());
            return Ok(());
        }
        drop(pending);
        match self.elastic.apply_changes(documents, deleted_file_ids) {
            Ok(true) => self.mark_elasticsearch_synced(sync_generation),
            Ok(false) => {
                self.mark_elasticsearch_dirty();
                Ok(())
            }
            Err(error) => {
                self.mark_elasticsearch_dirty();
                Err(error)
            }
        }
    }

    pub fn delete_file(&self, file_id: i64) -> Result<(), String> {
        self.apply_changes(&[], &[file_id])
    }

    pub fn delete_folder(&self, folder_id: i64) -> Result<(), String> {
        let mut pending = self.pending_elastic.lock().map_err(|e| e.to_string())?;
        let sync_generation = self.mark_elasticsearch_dirty();
        let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
        writer.delete_term(Term::from_field_i64(self.fields.folder_id, folder_id));
        writer.commit().map_err(|e| e.to_string())?;
        self.reader.reload().map_err(|e| e.to_string())?;
        drop(writer);
        if pending.active {
            pending.folders.insert(folder_id);
            return Ok(());
        }
        drop(pending);
        if self.elastic.delete_folder(folder_id)? {
            self.mark_elasticsearch_synced(sync_generation)?;
        }
        Ok(())
    }

    pub fn rebuild(&self, conn: &Connection) -> Result<(), String> {
        self.rebuild_with_progress(conn, |_, _| {})
    }

    pub fn rebuild_with_progress(
        &self,
        conn: &Connection,
        mut progress: impl FnMut(u64, u64),
    ) -> Result<(), String> {
        let total: u64 = conn
            .query_row(
                "SELECT COUNT(*) FROM files WHERE index_status = 'indexed'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let mut pending = self.pending_elastic.lock().map_err(|e| e.to_string())?;
        let mut processed = 0;
        progress(0, total);
        let sync_generation = self.mark_elasticsearch_dirty();
        {
            let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
            writer.delete_all_documents().map_err(|e| e.to_string())?;
            for_each_document(conn, |document| {
                if pending.active {
                    pending.files.insert(document.file_id);
                }
                processed += 1;
                if processed % 500 == 0 {
                    progress(processed, total);
                }
                writer
                    .add_document(self.to_document(document))
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            })?;
            writer.commit().map_err(|e| e.to_string())?;
            self.reader.reload().map_err(|e| e.to_string())?;
        }
        progress(processed, total);
        if pending.active {
            return Ok(());
        }
        drop(pending);
        if self.elastic.rebuild(conn)? {
            self.mark_elasticsearch_synced(sync_generation)?;
        }
        Ok(())
    }

    pub fn synchronize_elasticsearch_with_progress(
        &self,
        conn: &Connection,
        mut progress: impl FnMut(u64, u64),
    ) -> Result<bool, String> {
        // Keep one SQLite snapshot for the bulk copy, then replay IDs changed while copying.
        // The app's primary connection and local search remain available throughout.
        let snapshot = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let expected: u64 = snapshot
            .query_row(
                "SELECT COUNT(*) FROM files WHERE index_status = 'indexed'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let actual = self.elastic.document_count()?;
        let marker_current = std::fs::read_to_string(&self.elastic_sync_marker)
            .is_ok_and(|value| value.trim() == ELASTIC_SYNC_MARKER_VERSION);
        let required = elasticsearch_sync_required(expected, actual, marker_current);
        if required {
            self.mark_elasticsearch_dirty();
            if !self
                .elastic
                .rebuild_with_progress(&snapshot, &mut progress)?
            {
                return Err("Search service disconnected during synchronization".into());
            }
        } else {
            progress(expected, expected);
        }
        snapshot.commit().map_err(|e| e.to_string())?;
        loop {
            let mut pending = self.pending_elastic.lock().map_err(|e| e.to_string())?;
            if pending.files.is_empty() && pending.folders.is_empty() {
                let generation = *self
                    .elastic_sync_generation
                    .lock()
                    .map_err(|e| e.to_string())?;
                self.mark_elasticsearch_synced(generation)?;
                pending.active = false;
                self.elastic_search_enabled.store(true, Ordering::Release);
                break;
            }
            let files = std::mem::take(&mut pending.files);
            let folders = std::mem::take(&mut pending.folders);
            drop(pending);
            for folder in folders {
                if !self.elastic.delete_folder(folder)? {
                    return Err("Search service disconnected during folder catch-up".into());
                }
            }
            let mut documents = Vec::new();
            let mut deletes = Vec::new();
            for id in files {
                let document = conn.query_row(
                    "SELECT id, folder_id, file_name, COALESCE(text_preview, ''), COALESCE(pdf_title, ''), COALESCE(pdf_author, ''), COALESCE(pdf_keywords, ''), file_extension, file_modified_at, file_size_bytes FROM files WHERE id = ?1 AND index_status = 'indexed'",
                    [id], row_to_document,
                ).optional().map_err(|e| e.to_string())?;
                if let Some(document) = document {
                    documents.push(document);
                } else {
                    deletes.push(id);
                }
                if documents.len() + deletes.len() >= 100 {
                    if !self.elastic.apply_changes(&documents, &deletes)? {
                        return Err("Search service disconnected during catch-up".into());
                    }
                    documents.clear();
                    deletes.clear();
                }
            }
            if !self.elastic.apply_changes(&documents, &deletes)? {
                return Err("Search service disconnected during catch-up".into());
            }
        }
        Ok(required)
    }

    pub fn search(
        &self,
        query_text: &str,
        filters: Option<&SearchFilters>,
        offset: usize,
        limit: usize,
    ) -> Result<SearchPage, String> {
        if !self.elastic_search_enabled.load(Ordering::Acquire) {
            return self.search_embedded(query_text, filters, offset, limit);
        }
        match self.elastic.search(query_text, filters, offset, limit) {
            Ok(Some(hits)) => return Ok(hits),
            Ok(None) => {}
            Err(error) => log::error!(
                "Elasticsearch query failed; using embedded fallback: {}",
                error
            ),
        }
        self.search_embedded(query_text, filters, offset, limit)
    }

    fn search_embedded(
        &self,
        query_text: &str,
        filters: Option<&SearchFilters>,
        offset: usize,
        limit: usize,
    ) -> Result<SearchPage, String> {
        let searcher = self.reader.searcher();
        let scope = filters.map_or(SearchScope::All, |filters| filters.scope);
        let fields = match scope {
            SearchScope::Title => vec![self.fields.file_name, self.fields.title],
            SearchScope::Content => vec![self.fields.content],
            SearchScope::All => vec![
                self.fields.file_name,
                self.fields.content,
                self.fields.title,
                self.fields.author,
                self.fields.keywords,
            ],
        };
        let mut parser = QueryParser::for_index(&self.index, fields);
        parser.set_conjunction_by_default();
        let embedded_query = query_text.replace(" | ", " OR ");
        // Keep field-qualified input from escaping the selected scope, including ranges.
        let embedded_query = if scope == SearchScope::All {
            embedded_query
        } else {
            literal_field_separators(&embedded_query)
        };
        let text_query = parser
            .parse_query(&embedded_query)
            .or_else(|_| parser.parse_query(&escape_query(query_text)))
            .map_err(|e| e.to_string())?;
        let query = self.filtered_query(text_query, filters);
        let (total, top_docs) = searcher
            .search(
                &query,
                &(Count, TopDocs::with_limit(limit).and_offset(offset)),
            )
            .map_err(|e| e.to_string())?;

        let hits = top_docs
            .into_iter()
            .map(|(score, address)| {
                let stored: TantivyDocument = searcher.doc(address).map_err(|e| e.to_string())?;
                let file_id = stored
                    .get_first(self.fields.file_id)
                    .and_then(|value| value.as_i64())
                    .ok_or_else(|| "Search index document has no file_id".to_string())?;
                Ok(SearchHit { file_id, score })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(SearchPage {
            hits,
            total: total as u64,
        })
    }

    fn filtered_query(
        &self,
        text_query: Box<dyn Query>,
        filters: Option<&SearchFilters>,
    ) -> Box<dyn Query> {
        let Some(filters) = filters else {
            return text_query;
        };
        let mut queries: Vec<Box<dyn Query>> = vec![text_query];
        if let Some(folder_id) = filters.folder_id {
            queries.push(Box::new(TermQuery::new(
                Term::from_field_i64(self.fields.folder_id, folder_id),
                tantivy::schema::IndexRecordOption::Basic,
            )));
        }
        if let Some(extension) = filters.file_extension.as_deref() {
            queries.push(Box::new(TermQuery::new(
                Term::from_field_text(self.fields.extension, &extension.to_lowercase()),
                tantivy::schema::IndexRecordOption::Basic,
            )));
        }
        if filters.size_min.is_some() || filters.size_max.is_some() {
            queries.push(Box::new(RangeQuery::new_i64_bounds(
                "size_bytes".to_string(),
                filters.size_min.map_or(Bound::Unbounded, Bound::Included),
                filters.size_max.map_or(Bound::Unbounded, Bound::Included),
            )));
        }
        if filters.date_from.is_some() || filters.date_to.is_some() {
            queries.push(Box::new(RangeQuery::new_str_bounds(
                "modified_at".to_string(),
                filters
                    .date_from
                    .as_deref()
                    .map_or(Bound::Unbounded, Bound::Included),
                filters
                    .date_to
                    .as_deref()
                    .map_or(Bound::Unbounded, Bound::Included),
            )));
        }
        Box::new(BooleanQuery::intersection(queries))
    }

    pub(crate) fn mark_elasticsearch_dirty(&self) -> u64 {
        let mut generation = self
            .elastic_sync_generation
            .lock()
            .expect("Elasticsearch sync generation lock poisoned");
        *generation = generation.wrapping_add(1);
        match std::fs::remove_file(&self.elastic_sync_marker) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => log::warn!("Cannot clear Elasticsearch sync marker: {error}"),
        }
        *generation
    }

    fn mark_elasticsearch_synced(&self, expected_generation: u64) -> Result<(), String> {
        let generation = self
            .elastic_sync_generation
            .lock()
            .map_err(|error| error.to_string())?;
        if *generation != expected_generation {
            return Ok(());
        }
        std::fs::write(&self.elastic_sync_marker, ELASTIC_SYNC_MARKER_VERSION)
            .map_err(|error| error.to_string())
    }

    fn to_document(&self, item: SearchDocument) -> TantivyDocument {
        doc!(
            self.fields.file_id => item.file_id,
            self.fields.folder_id => item.folder_id,
            self.fields.file_name => item.file_name,
            self.fields.content => item.content,
            self.fields.title => item.title,
            self.fields.author => item.author,
            self.fields.keywords => item.keywords,
            self.fields.extension => item.extension,
            self.fields.modified_at => item.modified_at,
            self.fields.size_bytes => item.size_bytes,
        )
    }
}

fn elasticsearch_sync_required(expected: u64, actual: Option<u64>, marker_current: bool) -> bool {
    !marker_current || actual != Some(expected)
}

pub fn document_for_file(conn: &Connection, file_id: i64) -> Result<SearchDocument, String> {
    conn.query_row(
        "SELECT id, folder_id, file_name, COALESCE(text_preview, ''), COALESCE(pdf_title, ''), COALESCE(pdf_author, ''), COALESCE(pdf_keywords, ''), file_extension, file_modified_at, file_size_bytes FROM files WHERE id = ?1",
        [file_id],
        row_to_document,
    )
    .map_err(|e| e.to_string())
}

pub(super) fn for_each_document(
    conn: &Connection,
    mut visitor: impl FnMut(SearchDocument) -> Result<(), String>,
) -> Result<(), String> {
    let mut statement = conn
        .prepare("SELECT id, folder_id, file_name, COALESCE(text_preview, ''), COALESCE(pdf_title, ''), COALESCE(pdf_author, ''), COALESCE(pdf_keywords, ''), file_extension, file_modified_at, file_size_bytes FROM files WHERE index_status = 'indexed'")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], row_to_document)
        .map_err(|e| e.to_string())?;
    for row in rows {
        visitor(row.map_err(|e| e.to_string())?)?;
    }
    Ok(())
}

fn row_to_document(row: &rusqlite::Row<'_>) -> rusqlite::Result<SearchDocument> {
    let content: String = row.get(3)?;
    Ok(SearchDocument {
        file_id: row.get(0)?,
        folder_id: row.get(1)?,
        file_name: row.get(2)?,
        content: normalize_cjk_ocr_spacing(&content),
        title: row.get(4)?,
        author: row.get(5)?,
        keywords: row.get(6)?,
        extension: row.get(7)?,
        modified_at: row.get(8)?,
        size_bytes: row.get(9)?,
    })
}

pub(crate) fn normalize_cjk_ocr_spacing(text: &str) -> String {
    let mut normalized = String::with_capacity(text.len());
    let mut whitespace = String::new();

    for character in text.chars() {
        if character.is_whitespace() {
            whitespace.push(character);
            continue;
        }

        if !whitespace.is_empty() {
            let previous = normalized.chars().next_back();
            if !previous.is_some_and(is_cjk) || !is_cjk(character) {
                normalized.push_str(&whitespace);
            }
            whitespace.clear();
        }
        normalized.push(character);
    }
    normalized.push_str(&whitespace);
    normalized
}

fn is_cjk(character: char) -> bool {
    matches!(
        character as u32,
        0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xF900..=0xFAFF
            | 0x20000..=0x2FA1F
    )
}

fn literal_field_separators(query: &str) -> String {
    let mut result = String::with_capacity(query.len());
    let mut escaped = false;
    for character in query.chars() {
        if character == ':' && !escaped {
            result.push('\\');
        }
        result.push(character);
        escaped = character == '\\' && !escaped;
    }
    result
}

fn escape_query(query: &str) -> String {
    query
        .split_whitespace()
        .map(|part| format!("\"{}\"", part.replace(['\"', '\\'], "")))
        .collect::<Vec<_>>()
        .join(" OR ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexes_and_finds_english_and_chinese_text() {
        let path = std::env::temp_dir().join(format!("xdocuments-search-{}", uuid::Uuid::new_v4()));
        let engine = SearchEngine::open(&path).unwrap();
        engine
            .upsert(SearchDocument {
                file_id: 7,
                folder_id: 2,
                file_name: "audit.pdf".to_string(),
                content: "Quarterly compliance report. 供 应 商 风 险 评 估。中 国 科 学 院。"
                    .to_string(),
                title: String::new(),
                author: String::new(),
                keywords: "audit risk".to_string(),
                extension: "pdf".to_string(),
                modified_at: "2026-01-01".to_string(),
                size_bytes: 100,
            })
            .unwrap();

        assert_eq!(
            engine.search("compliance", None, 0, 10).unwrap().hits[0].file_id,
            7
        );
        assert_eq!(
            engine
                .search("\"compliance\" | \"missingterm\"", None, 0, 10)
                .unwrap()
                .hits[0]
                .file_id,
            7
        );
        assert_eq!(
            engine.search("供应商风险", None, 0, 10).unwrap().hits[0].file_id,
            7
        );
        assert_eq!(
            engine.search("中国", None, 0, 10).unwrap().hits[0].file_id,
            7
        );

        for (file_id, folder_id, size_bytes) in [(8, 2, 200), (9, 3, 100)] {
            engine
                .upsert(SearchDocument {
                    file_id,
                    folder_id,
                    file_name: format!("audit-{file_id}.pdf"),
                    content: "Quarterly compliance report".to_string(),
                    title: String::new(),
                    author: String::new(),
                    keywords: String::new(),
                    extension: "pdf".to_string(),
                    modified_at: "2026-02-01".to_string(),
                    size_bytes,
                })
                .unwrap();
        }
        let second_page = engine.search("compliance", None, 1, 1).unwrap();
        assert_eq!(second_page.total, 3);
        assert_eq!(second_page.hits.len(), 1);
        let filtered = engine
            .search(
                "compliance",
                Some(&SearchFilters {
                    scope: SearchScope::All,
                    folder_id: Some(2),
                    date_from: Some("2026-01-01".to_string()),
                    date_to: Some("2026-01-31T23:59:59".to_string()),
                    size_min: Some(50),
                    size_max: Some(150),
                    file_extension: Some("PDF".to_string()),
                }),
                0,
                10,
            )
            .unwrap();
        assert_eq!(filtered.total, 1);
        assert_eq!(filtered.hits[0].file_id, 7);

        drop(engine);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn existing_index_supports_scopes_and_folders_without_reindexing() {
        let path = std::env::temp_dir().join(format!("xdocuments-scopes-{}", uuid::Uuid::new_v4()));
        {
            let engine = SearchEngine::open(&path).unwrap();
            let documents = [
                (1, 10, "星河.pdf", "ordinary", ""),
                (2, 10, "body.pdf", "星河", ""),
                (3, 20, "metadata.pdf", "ordinary", "星河"),
                (4, 20, "星河.pdf", "星河", ""),
            ]
            .map(
                |(file_id, folder_id, name, content, title)| SearchDocument {
                    file_id,
                    folder_id,
                    file_name: name.into(),
                    content: content.into(),
                    title: title.into(),
                    author: "authoronly".into(),
                    keywords: "keywordonly".into(),
                    extension: "pdf".into(),
                    modified_at: "2026-01-01".into(),
                    size_bytes: 100,
                },
            );
            engine.apply_changes(&documents, &[]).unwrap();
        }
        let before = std::fs::read(path.join("meta.json")).unwrap();
        let engine = SearchEngine::open(&path).unwrap();
        for (scope, folder_id, expected) in [
            (SearchScope::All, None, vec![1, 2, 3, 4]),
            (SearchScope::Title, None, vec![1, 3, 4]),
            (SearchScope::Content, None, vec![2, 4]),
            (SearchScope::Title, Some(10), vec![1]),
            (SearchScope::Title, Some(20), vec![3, 4]),
            (SearchScope::Content, Some(10), vec![2]),
            (SearchScope::Content, Some(999), vec![]),
        ] {
            let filters = SearchFilters {
                scope,
                folder_id,
                ..Default::default()
            };
            let page = engine.search("星河", Some(&filters), 0, 10).unwrap();
            let mut actual: Vec<_> = page.hits.iter().map(|hit| hit.file_id).collect();
            actual.sort();
            assert_eq!(actual, expected, "{scope:?} {folder_id:?}");
            assert_eq!(page.total, expected.len() as u64);
            let paged = engine.search("星河", Some(&filters), 1, 1).unwrap();
            assert_eq!(paged.total, expected.len() as u64);
            assert_eq!(paged.hits.len(), usize::from(expected.len() > 1));
        }
        for scope in [SearchScope::Title, SearchScope::Content] {
            let filters = SearchFilters {
                scope,
                ..Default::default()
            };
            for query in [
                "authoronly",
                "keywordonly",
                "author:authoronly",
                "folder_id:10",
                "file_id:[1 TO 4]",
            ] {
                assert_eq!(
                    engine.search(query, Some(&filters), 0, 10).unwrap().total,
                    0,
                    "{scope:?}: {query}"
                );
            }
        }
        let filters = SearchFilters {
            scope: SearchScope::Content,
            ..Default::default()
        };
        assert_eq!(
            engine
                .search("(星河) | (不存在)", Some(&filters), 0, 10)
                .unwrap()
                .total,
            2
        );
        assert_eq!(before, std::fs::read(path.join("meta.json")).unwrap());
        assert_eq!(engine.reader.searcher().num_docs(), 4);
        let legacy: SearchFilters = serde_json::from_str(r#"{"folder_id":10}"#).unwrap();
        assert_eq!(legacy.scope, SearchScope::All);
        assert!(serde_json::from_str::<SearchFilters>(r#"{"scope":"unknown"}"#).is_err());
        drop(engine);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    #[ignore = "requires XDOCUMENTS_ELASTICSEARCH_HOME"]
    fn scoped_search_matches_real_elasticsearch_without_changing_existing_indexes() {
        let distribution = std::env::var("XDOCUMENTS_ELASTICSEARCH_HOME").unwrap();
        let path =
            std::env::temp_dir().join(format!("xdocuments-real-scopes-{}", uuid::Uuid::new_v4()));
        let engine = SearchEngine::open(&path.join("tantivy")).unwrap();
        engine.configure_elasticsearch(
            PathBuf::from(distribution),
            path.join("es-data"),
            path.join("logs"),
        );
        engine.start_elasticsearch().unwrap();
        let documents: Vec<_> = (0..1000)
            .map(|id| SearchDocument {
                file_id: id,
                folder_id: id % 4,
                file_name: if id % 3 == 0 {
                    "星河 audit.pdf"
                } else {
                    "ordinary.pdf"
                }
                .into(),
                title: if id % 3 == 2 { "星河 audit" } else { "" }.into(),
                content: if id % 3 == 1 {
                    "星河 audit"
                } else {
                    "ordinary report"
                }
                .into(),
                author: "authoronly".into(),
                keywords: "keywordonly".into(),
                extension: "pdf".into(),
                modified_at: "2026-01-01".into(),
                size_bytes: 100,
            })
            .collect();
        engine.apply_changes(&documents, &[]).unwrap();
        let meta = std::fs::read(path.join("tantivy/meta.json")).unwrap();
        let endpoint = engine.backend_status().endpoint.unwrap();
        let snapshot = || -> serde_json::Value {
            reqwest::blocking::get(format!("{endpoint}/xdocuments-v1/_stats?filter_path=indices.*.primaries.docs,indices.*.primaries.indexing.index_total"))
                .unwrap().error_for_status().unwrap().json().unwrap()
        };
        let before = snapshot();
        assert!(before.get("indices").is_some());
        let started = std::time::Instant::now();
        let mut queries = 0;
        for scope in [SearchScope::All, SearchScope::Title, SearchScope::Content] {
            for folder_id in [None, Some(0), Some(1), Some(3), Some(999)] {
                let filters = SearchFilters {
                    scope,
                    folder_id,
                    ..Default::default()
                };
                for query in ["星河", "audit", "(星河) | (missingterm)", "authoronly"] {
                    let elastic = engine
                        .elastic
                        .search(query, Some(&filters), 0, 100)
                        .unwrap()
                        .unwrap();
                    let embedded = engine
                        .search_embedded(query, Some(&filters), 0, 100)
                        .unwrap();
                    assert_eq!(
                        elastic.total, embedded.total,
                        "{query}: {scope:?} {folder_id:?}"
                    );
                    assert_eq!(elastic.hits.len(), embedded.hits.len());
                    for hit in &elastic.hits {
                        let document = &documents[hit.file_id as usize];
                        assert!(folder_id.is_none_or(|folder| folder == document.folder_id));
                        if query != "authoronly" {
                            match scope {
                                SearchScope::Title => assert!(
                                    document.file_name.contains("星河")
                                        || document.title.contains("星河")
                                ),
                                SearchScope::Content => assert!(document.content.contains("星河")),
                                SearchScope::All => (),
                            }
                        }
                    }
                    queries += 1;
                }
            }
        }
        println!("Validated {queries} scope/folder/query combinations on 1000 indexed PDFs in {} ms (both backends)", started.elapsed().as_millis());
        assert_eq!(before, snapshot());
        assert_eq!(meta, std::fs::read(path.join("tantivy/meta.json")).unwrap());
        drop(engine);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn removes_only_whitespace_between_cjk_characters() {
        assert_eq!(
            normalize_cjk_ocr_spacing("## Page 1\n\n中 国 科 学 院 OCR 2026"),
            "## Page 1\n\n中国科学院 OCR 2026"
        );
        assert_eq!(normalize_cjk_ocr_spacing("云 上  i 西 安"), "云上  i 西安");
    }

    #[test]
    fn local_search_remains_available_and_changes_are_queued_during_service_startup() {
        let path =
            std::env::temp_dir().join(format!("xdocuments-local-first-{}", uuid::Uuid::new_v4()));
        let engine = SearchEngine::open(&path).unwrap();
        engine.prepare_background_sync();
        let document = SearchDocument {
            file_id: 7,
            folder_id: 1,
            file_name: "available.pdf".into(),
            content: "localavailable".into(),
            title: String::new(),
            author: String::new(),
            keywords: String::new(),
            extension: "pdf".into(),
            modified_at: "2026-11-27".into(),
            size_bytes: 100,
        };
        engine.upsert(document).unwrap();
        assert_eq!(
            engine.search("localavailable", None, 0, 10).unwrap().total,
            1
        );
        assert!(!engine.backend_status().connected);
        assert!(engine.pending_elastic.lock().unwrap().files.contains(&7));
        engine.delete_folder(1).unwrap();
        assert_eq!(
            engine.search("localavailable", None, 0, 10).unwrap().total,
            0
        );
        assert!(engine.pending_elastic.lock().unwrap().folders.contains(&1));
        engine.finish_background_sync_failed();
        assert!(!engine.pending_elastic.lock().unwrap().active);
        assert!(engine.pending_elastic.lock().unwrap().files.is_empty());
        assert!(engine.search("anything", None, 0, 10).is_ok());
        drop(engine);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    #[ignore = "requires XDOCUMENTS_ELASTICSEARCH_HOME; starts and restarts real Elasticsearch"]
    fn background_sync_replays_changes_and_reuses_persisted_indexes() {
        let path = std::env::temp_dir().join(format!(
            "xdocuments-background-sync-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&path).unwrap();
        let conn = Connection::open(path.join("library.db")).unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        conn.execute_batch("INSERT INTO watched_folders(id,path) VALUES(1,'first'),(2,'second');
            INSERT INTO files(id,folder_id,relative_path,file_name,file_size_bytes,content_hash,file_modified_at,index_status,text_preview) VALUES
            (1,1,'delete.pdf','delete.pdf',100,'a','2026-11-27','indexed','olddelete'),
            (2,1,'update.pdf','update.pdf',100,'b','2026-11-27','indexed','oldcontent'),
            (3,2,'folder.pdf','folder.pdf',100,'c','2026-11-27','indexed','foldergone');").unwrap();
        let engine = SearchEngine::open(&path.join("tantivy")).unwrap();
        engine.rebuild(&conn).unwrap();
        let meta = std::fs::read(path.join("tantivy/meta.json")).unwrap();
        engine.configure_elasticsearch(
            PathBuf::from(std::env::var("XDOCUMENTS_ELASTICSEARCH_HOME").unwrap()),
            path.join("es-data"),
            path.join("logs"),
        );
        engine.prepare_background_sync();
        let started = std::time::Instant::now();
        assert_eq!(engine.search("oldcontent", None, 0, 10).unwrap().total, 1);
        println!(
            "LOCAL_SEARCH_DURING_STARTUP elapsed_ms={}",
            started.elapsed().as_millis()
        );
        engine.start_elasticsearch().unwrap();
        println!(
            "BACKGROUND_SERVICE_READY elapsed_ms={}",
            started.elapsed().as_millis()
        );
        assert!(!engine.backend_status().connected);
        let reader = Connection::open_with_flags(
            path.join("library.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let mut changed = false;
        let mut progress = Vec::new();
        let rebuilt = engine.synchronize_elasticsearch_with_progress(&reader, |done,total| {
            progress.push((done,total));
            if !changed {
                changed = true;
                // This write would fail if bulk synchronization held the app's DB connection or a rollback journal reader.
                conn.execute_batch("UPDATE files SET text_preview='updatedunique' WHERE id=2;
                    DELETE FROM files WHERE id=1;
                    DELETE FROM watched_folders WHERE id=2;
                    INSERT INTO files(id,folder_id,relative_path,file_name,file_size_bytes,content_hash,file_modified_at,index_status,text_preview) VALUES(4,1,'new.pdf','new.pdf',100,'d','2026-11-27','indexed','newunique');").unwrap();
                engine.apply_changes(&[document_for_file(&conn,2).unwrap(), document_for_file(&conn,4).unwrap()], &[1]).unwrap();
                engine.delete_folder(2).unwrap();
                assert_eq!(engine.search("updatedunique",None,0,10).unwrap().total,1);
                assert_eq!(engine.search("newunique",None,0,10).unwrap().total,1);
            }
        }).unwrap();
        assert!(rebuilt);
        assert_eq!(progress.first(), Some(&(0, 3)));
        assert_eq!(progress.last(), Some(&(3, 3)));
        assert!(engine.backend_status().connected);
        for (query, count) in [
            ("updatedunique", 1),
            ("newunique", 1),
            ("oldcontent", 0),
            ("olddelete", 0),
            ("foldergone", 0),
        ] {
            assert_eq!(
                engine.search(query, None, 0, 10).unwrap().total,
                count,
                "{query}"
            );
        }
        // Local mutations changed this index; capture the final version before a normal restart.
        assert_ne!(meta, std::fs::read(path.join("tantivy/meta.json")).unwrap());
        let final_meta = std::fs::read(path.join("tantivy/meta.json")).unwrap();
        drop(engine);
        let engine = SearchEngine::open(&path.join("tantivy")).unwrap();
        engine.configure_elasticsearch(
            PathBuf::from(std::env::var("XDOCUMENTS_ELASTICSEARCH_HOME").unwrap()),
            path.join("es-data"),
            path.join("logs"),
        );
        engine.prepare_background_sync();
        engine.start_elasticsearch().unwrap();
        let mut progress = Vec::new();
        assert!(!engine
            .synchronize_elasticsearch_with_progress(&reader, |done, total| progress
                .push((done, total)))
            .unwrap());
        assert_eq!(progress, vec![(2, 2)]);
        assert_eq!(
            final_meta,
            std::fs::read(path.join("tantivy/meta.json")).unwrap()
        );
        assert_eq!(engine.search("newunique", None, 0, 10).unwrap().total, 1);
        println!(
            "WARM_RESTART synchronized_without_rebuild=true documents=2 local_index_unchanged=true"
        );
        drop(engine);
        drop(reader);
        drop(conn);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn sync_check_requires_current_marker_and_matching_count() {
        assert!(elasticsearch_sync_required(2, None, true));
        assert!(elasticsearch_sync_required(2, Some(1), true));
        assert!(elasticsearch_sync_required(2, Some(2), false));
        assert!(!elasticsearch_sync_required(2, Some(2), true));
    }

    #[test]
    fn older_concurrent_sync_cannot_mark_newer_changes_as_complete() {
        let path = std::env::temp_dir().join(format!(
            "xdocuments-sync-generation-{}",
            uuid::Uuid::new_v4()
        ));
        let engine = SearchEngine::open(&path).unwrap();
        let older = engine.mark_elasticsearch_dirty();
        let newer = engine.mark_elasticsearch_dirty();

        engine.mark_elasticsearch_synced(older).unwrap();
        assert!(!engine.elastic_sync_marker.is_file());
        engine.mark_elasticsearch_synced(newer).unwrap();
        assert!(engine.elastic_sync_marker.is_file());

        drop(engine);
        let _ = std::fs::remove_dir_all(path);
    }
}
