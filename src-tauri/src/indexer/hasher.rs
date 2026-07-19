use sha2::{Sha256, Digest};
use md5::Md5;
use std::fs;
use std::io::{self, Read};
use std::path::Path;

/// Compute SHA-256 hash of a file's contents.
/// Reads in 8KB chunks to bound memory usage.
pub fn hash_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];

    loop {
        let bytes_read = file.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    let hash = hasher.finalize();
    Ok(format!("{:x}", hash))
}

/// Compute MD5 hash of a file's contents.
/// Reads in 8KB chunks to bound memory usage.
pub fn hash_file_md5(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Md5::new();
    let mut buffer = [0u8; 8192];

    loop {
        let bytes_read = file.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    let hash = hasher.finalize();
    Ok(format!("{:x}", hash))
}

/// Quick check: does a file need re-indexing?
/// Returns true if the file's mtime or size has changed since last record.
pub fn file_changed(path: &Path, last_size: i64, last_modified: &str) -> bool {
    if let Ok(meta) = fs::metadata(path) {
        let current_size = meta.len() as i64;
        if current_size != last_size {
            return true;
        }
        if let Ok(modified) = meta.modified() {
            let modified_str = format!("{:?}", modified);
            return modified_str != last_modified;
        }
    }
    // If we can't stat the file, assume it changed
    true
}
