// Network/SMB file watcher — Phase 2
// Polling-based watcher for SMB shares where filesystem events are unreliable.
// Configurable polling interval (default 300s).
// Compares mtime + file_size against database records before triggering re-index.
