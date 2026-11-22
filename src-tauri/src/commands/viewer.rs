use std::fs;
use std::io::Read;

const MAX_READ_RANGE_BYTES: u64 = 64 * 1024 * 1024;

#[tauri::command]
pub async fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    crate::background::run(move || {
        fs::read(crate::utils::path::normalize_path(&path))
            .map_err(|e| format!("Failed to read file: {}", e))
    })
    .await
}

#[tauri::command]
pub async fn read_file_bytes_range(path: String, start: u64, end: u64) -> Result<Vec<u8>, String> {
    crate::background::run(move || {
        if end < start {
            return Err(
                "Invalid byte range: end must be greater than or equal to start".to_string(),
            );
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
    })
    .await
}

#[tauri::command]
pub async fn show_in_folder(path: String) -> Result<(), String> {
    crate::background::run(move || {
        reveal_in_file_manager(&path)
            .map_err(|error| format!("Failed to open containing folder: {error}"))
    })
    .await
}

// Explorer parses quoted /select arguments inconsistently. Use a shell item ID
// instead; SHParseDisplayName also accepts long paths in display form.
#[cfg(windows)]
fn reveal_in_file_manager(path: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::RPC_E_CHANGED_MODE,
        System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED},
        UI::Shell::{SHOpenFolderAndSelectItems, SHParseDisplayName},
    };

    let canonical = fs::canonicalize(crate::utils::path::normalize_path(path))
        .map_err(|error| format!("File is unavailable: {error}"))?;
    let display = crate::utils::path::display_path(&canonical);
    let wide: Vec<u16> = std::ffi::OsStr::new(&display)
        .encode_wide()
        .chain(Some(0))
        .collect();

    // This command runs on a blocking worker. Balance COM initialization on this
    // thread, and leave an existing apartment untouched if it uses another mode.
    struct ComGuard(bool);
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() }
            }
        }
    }
    unsafe {
        let initialized = CoInitializeEx(ptr::null(), COINIT_APARTMENTTHREADED as u32);
        if initialized < 0 && initialized != RPC_E_CHANGED_MODE {
            return Err(format!(
                "Shell initialization failed (0x{:08X})",
                initialized as u32
            ));
        }
        let _com = ComGuard(initialized >= 0);
        let mut item = ptr::null_mut();
        let parsed = SHParseDisplayName(
            wide.as_ptr(),
            ptr::null_mut(),
            &mut item,
            0,
            ptr::null_mut(),
        );
        if parsed < 0 {
            return Err(format!(
                "Shell could not resolve the file (0x{:08X})",
                parsed as u32
            ));
        }
        let opened = SHOpenFolderAndSelectItems(item, 0, ptr::null(), 0);
        CoTaskMemFree(item.cast());
        if opened < 0 {
            return Err(format!(
                "Shell could not reveal the file (0x{:08X})",
                opened as u32
            ));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn reveal_in_file_manager(path: &str) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{read_file_bytes, read_file_bytes_range, show_in_folder, MAX_READ_RANGE_BYTES};

    fn test_file() -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("xdocuments-viewer-{}.bin", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"0123456789").unwrap();
        path
    }

    #[tokio::test]
    async fn rejects_empty_and_missing_reveal_paths() {
        assert!(show_in_folder(String::new()).await.is_err());
        let missing =
            std::env::temp_dir().join(format!("xdocuments-missing-{}.pdf", uuid::Uuid::new_v4()));
        assert!(show_in_folder(missing.to_string_lossy().into_owned())
            .await
            .unwrap_err()
            .contains("Failed to open containing folder"));
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "Opens Explorer; set XDOCUMENTS_REVEAL_TEST_PATH to an existing file and verify selection"]
    async fn reveals_existing_file_in_native_explorer() {
        let path = std::env::var("XDOCUMENTS_REVEAL_TEST_PATH")
            .expect("Set XDOCUMENTS_REVEAL_TEST_PATH to the file to reveal");
        show_in_folder(path).await.unwrap();
    }

    #[tokio::test]
    async fn reads_full_files_and_exact_byte_ranges() {
        let path = test_file();
        let path_string = path.to_string_lossy().to_string();
        assert_eq!(
            read_file_bytes(path_string.clone()).await.unwrap(),
            b"0123456789"
        );
        assert_eq!(
            read_file_bytes_range(path_string, 2, 6).await.unwrap(),
            b"2345"
        );
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn rejects_reversed_oversized_and_out_of_bounds_ranges() {
        let path = test_file();
        let path_string = path.to_string_lossy().to_string();
        assert!(read_file_bytes_range(path_string.clone(), 5, 4)
            .await
            .unwrap_err()
            .contains("Invalid byte range"));
        assert!(
            read_file_bytes_range(path_string.clone(), 0, MAX_READ_RANGE_BYTES + 1)
                .await
                .unwrap_err()
                .contains("exceeds")
        );
        assert!(read_file_bytes_range(path_string, 8, 12)
            .await
            .unwrap_err()
            .contains("Failed to read range"));
        std::fs::remove_file(path).unwrap();
    }
}
