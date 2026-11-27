use crate::{db::Database, search::SearchEngine};
use serde::Serialize;
use std::sync::Mutex;
use std::time::Instant;
use tauri::{AppHandle, Manager, State};

#[derive(Clone, Debug, Serialize)]
pub struct StartupStatus {
    pub phase: &'static str,
    pub ready: bool,
    pub error: Option<String>,
    pub completed_steps: u8,
    pub elapsed_ms: u64,
    pub processed: u64,
    pub total: Option<u64>,
}

pub struct StartupState(Mutex<StartupStatus>, Instant);

impl Default for StartupState {
    fn default() -> Self {
        Self(
            Mutex::new(StartupStatus {
                phase: "database",
                ready: false,
                error: None,
                completed_steps: 0,
                elapsed_ms: 0,
                processed: 0,
                total: None,
            }),
            Instant::now(),
        )
    }
}

impl StartupState {
    fn update(&self, phase: &'static str, ready: bool, error: Option<String>) {
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = StartupStatus {
            phase,
            ready,
            error,
            completed_steps: match phase {
                "database" => 0,
                "local_index" => 1,
                "search_starting" => 2,
                "search_sync" => 3,
                "ready" => 4,
                _ => 0,
            },
            elapsed_ms: self.1.elapsed().as_millis() as u64,
            processed: 0,
            total: None,
        };
        log::info!(
            "Startup phase={phase} library_ready={ready} elapsed_ms={}",
            self.1.elapsed().as_millis()
        );
    }

    fn progress(&self, processed: u64, total: u64) {
        let mut status = self.0.lock().unwrap_or_else(|e| e.into_inner());
        status.processed = processed;
        status.total = Some(total);
    }

    fn snapshot(&self) -> StartupStatus {
        let mut status = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if status.phase != "ready" && status.phase != "failed" {
            status.elapsed_ms = self.1.elapsed().as_millis() as u64;
        }
        status
    }
}

#[tauri::command]
pub fn get_startup_status(startup: State<'_, StartupState>) -> StartupStatus {
    startup.snapshot()
}

pub fn start(app: AppHandle) -> Result<(), std::io::Error> {
    std::thread::Builder::new()
        .name("application-startup".into())
        .spawn(move || {
            let result =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| initialize(&app)));
            let error = match result {
                Ok(Ok(())) => return,
                Ok(Err(error)) => error,
                Err(_) => {
                    "Application initialization stopped unexpectedly. See runtime logs.".into()
                }
            };
            log::error!("Application startup failed: {error}");
            let startup = app.state::<StartupState>();
            let ready = startup.snapshot().ready;
            if ready {
                if let Some(engine) = app.try_state::<SearchEngine>() {
                    engine.finish_background_sync_failed();
                }
            }
            startup.update(if ready { "ready" } else { "failed" }, ready, Some(error));
        })?;
    Ok(())
}

fn initialize(app: &AppHandle) -> Result<(), String> {
    let startup = app.state::<StartupState>();
    startup.update("database", false, None);
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let database = Database::new(&directory).map_err(|error| error.to_string())?;
    crate::db::schema::create_indexes(&database.get_connection())
        .map_err(|error| error.to_string())?;

    startup.update("local_index", false, None);
    let engine = SearchEngine::open(&directory.join("search-index-v1"))?;
    if engine.is_empty() {
        engine.rebuild_with_progress(&database.get_connection(), |done, total| {
            startup.progress(done, total)
        })?;
    }
    let distribution = crate::find_elasticsearch_distribution(app);
    if let Some(distribution) = distribution.as_ref() {
        let elastic_directory = directory.join("elasticsearch");
        engine.configure_elasticsearch(
            distribution.clone(),
            elastic_directory.join("data"),
            elastic_directory.join("logs"),
        );
    }
    if distribution.is_some() {
        engine.prepare_background_sync();
    }
    // Publish dependencies before the frontend is allowed to issue library commands.
    app.manage(database);
    app.manage(engine);
    let engine = app.state::<SearchEngine>();
    let mut warning = None;
    if distribution.is_some() {
        // The persisted local index is already usable; JVM startup must not gate the library.
        startup.update("search_starting", true, None);
        match engine.start_elasticsearch() {
            Ok(()) => {
                startup.update("search_sync", true, None);
                // An independent WAL reader keeps library commands and OCR free during bulk sync.
                let database = app.state::<Database>();
                let connection = rusqlite::Connection::open_with_flags(
                    database.path(),
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                )
                .map_err(|e| e.to_string())?;
                connection
                    .busy_timeout(std::time::Duration::from_secs(10))
                    .map_err(|e| e.to_string())?;
                if let Err(error) = engine
                    .synchronize_elasticsearch_with_progress(&connection, |done, total| {
                        startup.progress(done, total)
                    })
                {
                    warning = Some(error);
                }
            }
            Err(error) => warning = Some(error),
        }
    } else {
        log::warn!("Bundled Elasticsearch distribution was not found; using embedded search");
    }
    if let Some(error) = warning.as_ref() {
        engine.finish_background_sync_failed();
        log::error!("Elasticsearch startup: {error}");
    }
    startup.update("ready", true, warning);
    log::info!(
        "XDocuments Manager initialized. Data dir: {}",
        directory.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_opens_before_optional_search_and_tracks_real_counts() {
        let state = StartupState::default();
        state.update("local_index", false, None);
        assert_eq!(state.snapshot().completed_steps, 1);
        state.update("search_starting", true, None);
        assert!(state.snapshot().ready);
        assert_eq!(state.snapshot().completed_steps, 2);
        state.update("search_sync", true, None);
        state.progress(500, 1000);
        assert_eq!(state.snapshot().processed, 500);
        assert_eq!(state.snapshot().total, Some(1000));
        assert_eq!(state.snapshot().completed_steps, 3);
    }

    #[test]
    fn reports_progress_and_preserves_startup_failure() {
        let state = StartupState::default();
        assert!(!state.snapshot().ready);
        state.update("local_index", false, None);
        assert_eq!(state.snapshot().phase, "local_index");
        state.update("failed", false, Some("database locked".into()));
        assert_eq!(state.snapshot().error.as_deref(), Some("database locked"));
        assert!(!state.snapshot().ready);
    }

    #[test]
    fn optional_search_failure_still_allows_the_library_to_open() {
        let state = StartupState::default();
        state.update("ready", true, Some("Elasticsearch unavailable".into()));
        assert!(state.snapshot().ready);
        assert!(state.snapshot().error.is_some());
    }
}
