use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Stream PDF paths without retaining the complete directory tree in memory.
pub fn walk_pdf_files(root: &Path) -> impl Iterator<Item = Result<PathBuf, String>> {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            // Skip hidden directories and files
            !e.file_name()
                .to_str()
                .map(|s| s.starts_with('.') || s.starts_with('$'))
                .unwrap_or(false)
        })
        .filter_map(|entry| match entry {
            Ok(entry) if entry.file_type().is_file() && is_pdf(entry.path()) => {
                Some(Ok(entry.into_path()))
            }
            Ok(_) => None,
            Err(error) => Some(Err(error.to_string())),
        })
}

fn is_pdf(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_walk_pdf_files() {
        let tmp =
            std::env::temp_dir().join(format!("xdocuments-test-walk-{}", uuid::Uuid::new_v4()));
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

        let files = walk_pdf_files(&tmp).collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(files.len(), 2);
        assert!(files.iter().any(|path| path.ends_with("doc.PDF")));

        fs::remove_dir_all(&tmp).unwrap();
    }
}
