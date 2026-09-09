use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;
use tantivy::collector::{Count, TopDocs};
use tantivy::directory::MmapDirectory;
use tantivy::query::{BooleanQuery, Query, QueryParser, RangeQuery, TermQuery};
use tantivy::schema::{TantivyDocument, Value};
use tantivy::tokenizer::{LowerCaser, NgramTokenizer, TextAnalyzer};
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, Term};

use super::elastic::ElasticRuntime;
use super::schema::{build_schema, SearchFields};
use crate::models::{SearchBackendStatus, SearchFilters};

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

pub struct SearchEngine {
    index: Index,
    reader: IndexReader,
    writer: Mutex<IndexWriter>,
    fields: SearchFields,
    elastic: ElasticRuntime,
    elastic_sync_marker: PathBuf,
    elastic_sync_generation: Mutex<u64>,
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
        self.elastic.status()
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
        let sync_generation = self.mark_elasticsearch_dirty();
        let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
        writer.delete_term(Term::from_field_i64(self.fields.folder_id, folder_id));
        writer.commit().map_err(|e| e.to_string())?;
        self.reader.reload().map_err(|e| e.to_string())?;
        if self.elastic.delete_folder(folder_id)? {
            self.mark_elasticsearch_synced(sync_generation)?;
        }
        Ok(())
    }

    pub fn rebuild(&self, conn: &Connection) -> Result<(), String> {
        let sync_generation = self.mark_elasticsearch_dirty();
        {
            let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
            writer.delete_all_documents().map_err(|e| e.to_string())?;
            for_each_document(conn, |document| {
                writer
                    .add_document(self.to_document(document))
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            })?;
            writer.commit().map_err(|e| e.to_string())?;
            self.reader.reload().map_err(|e| e.to_string())?;
        }
        if self.elastic.rebuild(conn)? {
            self.mark_elasticsearch_synced(sync_generation)?;
        }
        Ok(())
    }

    pub fn synchronize_elasticsearch(&self, conn: &Connection) -> Result<bool, String> {
        let expected = conn
            .query_row(
                "SELECT COUNT(*) FROM files WHERE index_status = 'indexed'",
                [],
                |row| row.get::<_, u64>(0),
            )
            .map_err(|error| error.to_string())?;
        let actual = self.elastic.document_count()?;
        let marker_current = std::fs::read_to_string(&self.elastic_sync_marker)
            .is_ok_and(|value| value.trim() == ELASTIC_SYNC_MARKER_VERSION);
        if !elasticsearch_sync_required(expected, actual, marker_current) {
            return Ok(false);
        }
        let sync_generation = self.mark_elasticsearch_dirty();
        if self.elastic.rebuild(conn)? {
            self.mark_elasticsearch_synced(sync_generation)?;
            return Ok(true);
        }
        Ok(false)
    }

    pub fn search(
        &self,
        query_text: &str,
        filters: Option<&SearchFilters>,
        offset: usize,
        limit: usize,
    ) -> Result<SearchPage, String> {
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
        let mut parser = QueryParser::for_index(
            &self.index,
            vec![
                self.fields.file_name,
                self.fields.content,
                self.fields.title,
                self.fields.author,
                self.fields.keywords,
            ],
        );
        parser.set_conjunction_by_default();
        let embedded_query = query_text.replace(" | ", " OR ");
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
    fn removes_only_whitespace_between_cjk_characters() {
        assert_eq!(
            normalize_cjk_ocr_spacing("## Page 1\n\n中 国 科 学 院 OCR 2026"),
            "## Page 1\n\n中国科学院 OCR 2026"
        );
        assert_eq!(normalize_cjk_ocr_spacing("云 上  i 西 安"), "云上  i 西安");
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
