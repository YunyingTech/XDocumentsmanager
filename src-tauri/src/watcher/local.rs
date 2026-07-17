// Local file watcher using the notify crate — Phase 2
// Uses Windows ReadDirectoryChangesW for efficient change detection.
// Debounced events (2s) trigger incremental indexing.
