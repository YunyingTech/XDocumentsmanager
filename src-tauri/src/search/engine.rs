use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use tantivy::collector::TopDocs;
use tantivy::directory::MmapDirectory;
use tantivy::query::QueryParser;
use tantivy::schema::{TantivyDocument, Value};
use tantivy::tokenizer::{LowerCaser, NgramTokenizer, TextAnalyzer};
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, Term};
use serde::Serialize;

use crate::models::{SearchBackendStatus, SearchFilters};
use super::elastic::ElasticRuntime;
use super::schema::{build_schema, SearchFields};

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

pub struct SearchEngine {
    index: Index,
    reader: IndexReader,
    writer: Mutex<IndexWriter>,
    fields: SearchFields,
    elastic: ElasticRuntime,
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
        let analyzer = TextAnalyzer::builder(
            NgramTokenizer::new(1, 3, false).map_err(|e| e.to_string())?,
        )
        .filter(LowerCaser)
        .build();
        index.tokenizers().register("xd_text", analyzer);
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()
            .map_err(|e| e.to_string())?;
        let writer = index.writer(50_000_000).map_err(|e| e.to_string())?;
        Ok(Self { index, reader, writer: Mutex::new(writer), fields, elastic: ElasticRuntime::new()? })
    }

    pub fn configure_elasticsearch(&self, distribution_dir: PathBuf, data_dir: PathBuf, logs_dir: PathBuf) {
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
        {
            let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
            writer.delete_term(Term::from_field_i64(self.fields.file_id, document.file_id));
            writer.add_document(self.to_document(document.clone())).map_err(|e| e.to_string())?;
            writer.commit().map_err(|e| e.to_string())?;
            self.reader.reload().map_err(|e| e.to_string())?;
        }
        self.elastic.upsert(&document).map(|_| ())
    }

    pub fn delete_file(&self, file_id: i64) -> Result<(), String> {
        let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
        writer.delete_term(Term::from_field_i64(self.fields.file_id, file_id));
        writer.commit().map_err(|e| e.to_string())?;
        self.reader.reload().map_err(|e| e.to_string())?;
        self.elastic.delete_file(file_id).map(|_| ())
    }

    pub fn delete_folder(&self, folder_id: i64) -> Result<(), String> {
        let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
        writer.delete_term(Term::from_field_i64(self.fields.folder_id, folder_id));
        writer.commit().map_err(|e| e.to_string())?;
        self.reader.reload().map_err(|e| e.to_string())?;
        self.elastic.delete_folder(folder_id).map(|_| ())
    }

    pub fn rebuild(&self, conn: &Connection) -> Result<(), String> {
        let documents = documents_from_connection(conn)?;
        {
            let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
            writer.delete_all_documents().map_err(|e| e.to_string())?;
            for document in documents {
                writer.add_document(self.to_document(document)).map_err(|e| e.to_string())?;
            }
            writer.commit().map_err(|e| e.to_string())?;
            self.reader.reload().map_err(|e| e.to_string())?;
        }
        self.elastic.rebuild(conn).map(|_| ())
    }

    pub fn search(&self, query_text: &str, filters: Option<&SearchFilters>, limit: usize) -> Result<Vec<SearchHit>, String> {
        match self.elastic.search(query_text, filters, limit) {
            Ok(Some(hits)) => return Ok(hits),
            Ok(None) => {}
            Err(error) => log::error!("Elasticsearch query failed; using embedded fallback: {}", error),
        }
        self.search_embedded(query_text, limit)
    }

    fn search_embedded(&self, query_text: &str, limit: usize) -> Result<Vec<SearchHit>, String> {
        let searcher = self.reader.searcher();
        let mut parser = QueryParser::for_index(
            &self.index,
            vec![self.fields.file_name, self.fields.content, self.fields.title, self.fields.author, self.fields.keywords],
        );
        parser.set_conjunction_by_default();
        let query = parser
            .parse_query(query_text)
            .or_else(|_| parser.parse_query(&escape_query(query_text)))
            .map_err(|e| e.to_string())?;
        let top_docs = searcher
            .search(&query, &TopDocs::with_limit(limit))
            .map_err(|e| e.to_string())?;

        top_docs
            .into_iter()
            .map(|(score, address)| {
                let stored: TantivyDocument = searcher.doc(address).map_err(|e| e.to_string())?;
                let file_id = stored
                    .get_first(self.fields.file_id)
                    .and_then(|value| value.as_i64())
                    .ok_or_else(|| "Search index document has no file_id".to_string())?;
                Ok(SearchHit { file_id, score })
            })
            .collect()
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

pub fn document_for_file(conn: &Connection, file_id: i64) -> Result<SearchDocument, String> {
    conn.query_row(
        "SELECT id, folder_id, file_name, COALESCE(text_preview, ''), COALESCE(pdf_title, ''), COALESCE(pdf_author, ''), COALESCE(pdf_keywords, ''), file_extension, file_modified_at, file_size_bytes FROM files WHERE id = ?1",
        [file_id],
        row_to_document,
    )
    .map_err(|e| e.to_string())
}

pub fn documents_from_connection(conn: &Connection) -> Result<Vec<SearchDocument>, String> {
    let mut statement = conn
        .prepare("SELECT id, folder_id, file_name, COALESCE(text_preview, ''), COALESCE(pdf_title, ''), COALESCE(pdf_author, ''), COALESCE(pdf_keywords, ''), file_extension, file_modified_at, file_size_bytes FROM files WHERE index_status = 'indexed'")
        .map_err(|e| e.to_string())?;
    let rows = statement.query_map([], row_to_document).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
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
        engine.upsert(SearchDocument {
            file_id: 7,
            folder_id: 2,
            file_name: "audit.pdf".to_string(),
            content: "Quarterly compliance report. 供 应 商 风 险 评 估。中 国 科 学 院。".to_string(),
            title: String::new(),
            author: String::new(),
            keywords: "audit risk".to_string(),
            extension: "pdf".to_string(),
            modified_at: "2026-01-01".to_string(),
            size_bytes: 100,
        }).unwrap();

        assert_eq!(engine.search("compliance", None, 10).unwrap()[0].file_id, 7);
        assert_eq!(engine.search("供应商风险", None, 10).unwrap()[0].file_id, 7);
        assert_eq!(engine.search("中国", None, 10).unwrap()[0].file_id, 7);

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
}
