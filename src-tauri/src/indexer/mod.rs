// Indexing pipeline — Phase 2 implementation
// For Phase 1 (MVP), indexing is placeholder: add_folder creates a folder record,
// and start_indexing marks jobs as complete.

pub mod walker;
pub mod hasher;
pub mod extractor;
pub mod pipeline;
