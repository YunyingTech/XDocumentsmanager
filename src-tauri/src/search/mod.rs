// Full-text search — Phase 2 uses Tantivy
// Phase 1 uses SQLite FTS5 (implemented in commands::search)
pub mod engine;
pub mod query;
pub mod schema;
