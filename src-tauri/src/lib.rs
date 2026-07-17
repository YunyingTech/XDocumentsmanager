mod commands;
mod db;
mod indexer;
mod models;
mod search;
mod smb;
mod utils;
mod watcher;

use db::Database;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Initialize logging
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Initialize database
            let app_data_dir = app.path().app_data_dir()
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;

            let database = Database::new(&app_data_dir)
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;

            // Create indexes
            {
                let conn = database.get_connection();
                db::schema::create_indexes(&conn)
                    .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;
            }

            // Store database in app state
            app.manage(database);

            log::info!("XDocuments Manager initialized. Data dir: {:?}", app_data_dir);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Folders
            commands::folders::add_folder,
            commands::folders::remove_folder,
            commands::folders::list_folders,
            commands::folders::update_folder,
            // Files
            commands::files::list_files,
            commands::files::get_file,
            commands::files::delete_file_record,
            commands::files::get_file_count,
            // Index
            commands::index::start_indexing,
            commands::index::pause_indexing,
            commands::index::get_index_status,
            commands::index::reindex_file,
            // Search
            commands::search::search,
            // Viewer
            commands::viewer::read_file_bytes,
            commands::viewer::read_file_bytes_range,
            // Settings
            commands::settings::get_setting,
            commands::settings::set_setting,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
