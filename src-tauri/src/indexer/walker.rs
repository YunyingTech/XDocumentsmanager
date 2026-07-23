use std::path::PathBuf;
use walkdir::WalkDir;

/// Walk a directory and return all PDF file paths.
/// Skips hidden directories and files.
pub fn walk_pdf_files(root: &PathBuf) -> Vec<PathBuf> {
    let mut files = Vec::new();

    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            // Skip hidden directories and files
            !e.file_name()
                .to_str()
                .map(|s| s.starts_with('.') || s.starts_with('$'))
                .unwrap_or(false)
        })
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
            let path = entry.path();
            if let Some(ext) = path.extension() {
                if ext.to_str().map(|e| e.to_lowercase() == "pdf").unwrap_or(false) {
                    files.push(path.to_path_buf());
                }
            }
        }
    }

    files
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_walk_pdf_files() {
        let tmp = std::env::temp_dir().join(format!(
            "xdocuments-test-walk-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&tmp).unwrap();

        // Create a PDF file
        fs::write(tmp.join("test.pdf"), b"%PDF-1.4 fake").unwrap();
        // Create a non-PDF file
        fs::write(tmp.join("readme.txt"), b"hello").unwrap();
        // Create nested directory
        fs::create_dir_all(tmp.join("sub")).unwrap();
        fs::write(tmp.join("sub/doc.PDF"), b"%PDF-1.4 fake").unwrap();
        fs::create_dir_all(tmp.join(".hidden")).unwrap();
        fs::write(tmp.join(".hidden/secret.pdf"), b"%PDF-1.4 fake").unwrap();
        fs::create_dir_all(tmp.join("$system")).unwrap();
        fs::write(tmp.join("$system/cache.pdf"), b"%PDF-1.4 fake").unwrap();

        let files = walk_pdf_files(&tmp);
        assert_eq!(files.len(), 2);
        assert!(files.iter().any(|path| path.ends_with("doc.PDF")));

        fs::remove_dir_all(&tmp).unwrap();
    }
}
