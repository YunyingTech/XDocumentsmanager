mod commands;
mod db;
mod indexer;
mod models;
mod paddle_runtime;
mod search;
mod smb;
mod utils;
mod watcher;

use db::Database;
use search::SearchEngine;
use commands::ocr_control::OcrTaskManager;
use tauri::Manager;
use std::path::{Path, PathBuf};

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
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .level_for("tantivy", log::LevelFilter::Warn)
                    .max_file_size(5 * 1024 * 1024)
                    .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
                    .build(),
            )?;

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

            let search_engine = SearchEngine::open(&app_data_dir.join("search-index-v1"))
                .map_err(|e| Box::<dyn std::error::Error>::from(e))?;
            if search_engine.is_empty() {
                let conn = database.get_connection();
                search_engine.rebuild(&conn)
                    .map_err(|e| Box::<dyn std::error::Error>::from(e))?;
            }
            if let Some(distribution_dir) = find_elasticsearch_distribution(app) {
                log::info!(
                    "Using Elasticsearch distribution: {}",
                    distribution_dir.display()
                );
                let elastic_dir = app_data_dir.join("elasticsearch");
                search_engine.configure_elasticsearch(
                    distribution_dir,
                    elastic_dir.join("data"),
                    elastic_dir.join("logs"),
                );
            } else {
                log::error!("Bundled Elasticsearch distribution was not found");
            }

            // Store database in app state
            app.manage(search_engine);
            app.manage(database);
            app.manage(OcrTaskManager::default());

            let app_handle = app.handle().clone();
            std::thread::Builder::new()
                .name("elasticsearch-startup".to_string())
                .spawn(move || {
                    let engine = app_handle.state::<SearchEngine>();
                    if !engine.backend_status().connected {
                        match engine.start_elasticsearch() {
                            Ok(()) => {
                                let database = app_handle.state::<Database>();
                                let conn = database.get_connection();
                                if let Err(error) = engine.rebuild(&conn) {
                                    log::error!("Failed to populate Elasticsearch: {}", error);
                                } else {
                                    log::info!("Bundled Elasticsearch is ready and synchronized");
                                }
                            }
                            Err(error) => log::error!("Bundled Elasticsearch failed to start: {}", error),
                        }
                    }
                })
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;

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
            commands::search::analyze_search_query,
            // Runtime logs
            commands::logs::get_runtime_logs,
            // Viewer
            commands::viewer::read_file_bytes,
            commands::viewer::read_file_bytes_range,
            commands::viewer::show_in_folder,
            // OCR
            commands::ocr::check_ocr_health,
            commands::ocr::submit_ocr_task,
            commands::ocr::query_ocr_task,
            commands::ocr::get_ocr_result,
            commands::ocr::sync_ocr_parse,
            commands::ocr::get_windows_ocr_status,
            commands::ocr::run_windows_ocr,
            commands::ocr::cancel_ocr_task,
            commands::ocr::cancel_all_ocr_tasks,
            commands::paddle_ocr::get_paddle_ocr_status,
            commands::paddle_ocr::install_paddle_ocr,
            commands::paddle_ocr::run_paddle_ocr,
            commands::ocr::get_ocr_output_dir,
            commands::ocr::list_ocr_candidates,
            commands::ocr::list_ocr_candidate_refs,
            // Settings
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::get_db_path,
            commands::settings::vacuum_database,
            commands::settings::get_openai_config,
            commands::settings::set_openai_config,
            commands::settings::test_openai_connection,
            commands::settings::get_search_backend_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn find_elasticsearch_distribution<R: tauri::Runtime>(app: &tauri::App<R>) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("resources").join("elasticsearch"));
        candidates.push(resource_dir.join("elasticsearch"));
    }

    #[cfg(debug_assertions)]
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("elasticsearch"),
    );

    candidates.into_iter().find_map(resolve_elasticsearch_distribution)
}

fn resolve_elasticsearch_distribution(path: PathBuf) -> Option<PathBuf> {
    if is_elasticsearch_distribution(&path) {
        return Some(path);
    }

    std::fs::read_dir(path)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|candidate| is_elasticsearch_distribution(candidate))
}

fn is_elasticsearch_distribution(path: &Path) -> bool {
    path.join("bin")
        .join(if cfg!(windows) {
            "elasticsearch.bat"
        } else {
            "elasticsearch"
        })
        .is_file()
}
