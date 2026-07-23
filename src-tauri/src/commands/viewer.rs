use std::fs;
use std::io::Read;

const MAX_READ_RANGE_BYTES: u64 = 64 * 1024 * 1024;

#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    fs::read(crate::utils::path::normalize_path(&path))
        .map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
pub fn read_file_bytes_range(path: String, start: u64, end: u64) -> Result<Vec<u8>, String> {
    if end < start {
        return Err("Invalid byte range: end must be greater than or equal to start".to_string());
    }
    let size = end - start;
    if size > MAX_READ_RANGE_BYTES {
        return Err(format!(
            "Requested byte range exceeds the {} MB limit",
            MAX_READ_RANGE_BYTES / 1024 / 1024
        ));
    }
    let mut file = fs::File::open(crate::utils::path::normalize_path(&path))
        .map_err(|e| format!("Failed to open file: {}", e))?;

    let mut buffer = vec![0u8; size as usize];

    use std::io::Seek;
    file.seek(std::io::SeekFrom::Start(start))
        .map_err(|e| format!("Failed to seek: {}", e))?;

    file.read_exact(&mut buffer)
        .map_err(|e| format!("Failed to read range: {}", e))?;

    Ok(buffer)
}

#[tauri::command]
pub fn show_in_folder(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", path))
            .spawn()
            .map_err(|e| format!("Failed to open File Explorer: {}", e))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("Show in folder is currently supported on Windows only".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{read_file_bytes, read_file_bytes_range, MAX_READ_RANGE_BYTES};

    fn test_file() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "xdocuments-viewer-{}.bin",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, b"0123456789").unwrap();
        path
    }

    #[test]
    fn reads_full_files_and_exact_byte_ranges() {
        let path = test_file();
        let path_string = path.to_string_lossy().to_string();
        assert_eq!(read_file_bytes(path_string.clone()).unwrap(), b"0123456789");
        assert_eq!(read_file_bytes_range(path_string, 2, 6).unwrap(), b"2345");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejects_reversed_oversized_and_out_of_bounds_ranges() {
        let path = test_file();
        let path_string = path.to_string_lossy().to_string();
        assert!(read_file_bytes_range(path_string.clone(), 5, 4)
            .unwrap_err()
            .contains("Invalid byte range"));
        assert!(read_file_bytes_range(path_string.clone(), 0, MAX_READ_RANGE_BYTES + 1)
            .unwrap_err()
            .contains("exceeds"));
        assert!(read_file_bytes_range(path_string, 8, 12)
            .unwrap_err()
            .contains("Failed to read range"));
        std::fs::remove_file(path).unwrap();
    }
}
