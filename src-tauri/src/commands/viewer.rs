use std::fs;
use std::io::Read;

#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
pub fn read_file_bytes_range(path: String, start: u64, end: u64) -> Result<Vec<u8>, String> {
    let mut file = fs::File::open(&path).map_err(|e| format!("Failed to open file: {}", e))?;

    let size = end - start;
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
