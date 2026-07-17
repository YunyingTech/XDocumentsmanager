use std::path::{Path, PathBuf};

/// Normalize a Windows path for long-path support.
/// Prepends `\\?\` prefix for paths over 260 characters.
pub fn normalize_path(path: &str) -> PathBuf {
    let path = path.trim_matches('"');

    // Handle UNC paths
    if path.starts_with("\\\\") {
        let normalized = format!(r"\\?\UNC\{}", &path[2..]);
        return PathBuf::from(normalized);
    }

    // Handle long local paths
    if path.len() >= 260 {
        return PathBuf::from(format!(r"\\?\{}", path));
    }

    PathBuf::from(path)
}

/// Get the display-friendly form of a path (strip \\?\ prefix)
pub fn display_path(path: &Path) -> String {
    let s = path.to_string_lossy();
    if s.starts_with(r"\\?\UNC\") {
        format!(r"\\{}", &s[8..])
    } else if s.starts_with(r"\\?\") {
        s[4..].to_string()
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_unc_path() {
        let result = normalize_path(r"\\server\share\folder");
        assert!(result.to_string_lossy().contains(r"\\?\UNC\server\share\folder"));
    }

    #[test]
    fn test_normalize_short_path() {
        let result = normalize_path(r"C:\data");
        assert_eq!(result, PathBuf::from(r"C:\data"));
    }

    #[test]
    fn test_display_unc_path() {
        let p = Path::new(r"\\?\UNC\server\share\file.pdf");
        assert_eq!(display_path(p), r"\\server\share\file.pdf");
    }
}
