// File system watcher — Phase 2
// Hybrid approach: notify crate for local NTFS drives, polling for SMB shares.

pub mod local;
pub mod network;
