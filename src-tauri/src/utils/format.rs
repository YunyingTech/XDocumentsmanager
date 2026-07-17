/// Format file size in human-readable form
pub fn format_file_size(bytes: i64) -> String {
    if bytes == 0 {
        return "0 B".to_string();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let i = ((bytes as f64).ln() / 1024_f64.ln()).floor() as usize;
    let i = i.min(units.len() - 1);
    let size = bytes as f64 / (1024_f64.powi(i as i32));
    if i == 0 {
        format!("{} {}", size as i64, units[i])
    } else {
        format!("{:.1} {}", size, units[i])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_file_size() {
        assert_eq!(format_file_size(0), "0 B");
        assert_eq!(format_file_size(1024), "1.0 KB");
        assert_eq!(format_file_size(1048576), "1.0 MB");
        assert_eq!(format_file_size(1073741824), "1.0 GB");
    }
}
