use crate::{db::Database, search::SearchEngine};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

#[derive(Clone, Debug, Serialize)]
pub struct StartupStatus {
    pub phase: &'static str,
    pub ready: bool,
    pub error: Option<String>,
}

pub struct StartupState(Mutex<StartupStatus>);

impl Default for StartupState {
    fn default() -> Self {
        Self(Mutex::new(StartupStatus {
            phase: "database",
            ready: false,
            error: None,
        }))
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
        };
    }

    fn snapshot(&self) -> StartupStatus {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
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
            app.state::<StartupState>()
                .update("failed", false, Some(error));
        })?;
    Ok(())
}

fn initialize(app: &AppHandle) -> Result<(), String> {
    let startup = app.state::<StartupState>();
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
        engine.rebuild(&database.get_connection())?;
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
    // Publish dependencies before the frontend is allowed to issue library commands.
    app.manage(database);
    app.manage(engine);
    let engine = app.state::<SearchEngine>();
    let mut warning = None;
    if distribution.is_some() {
        startup.update("search_starting", false, None);
        match engine.start_elasticsearch() {
            Ok(()) => {
                startup.update("search_sync", false, None);
                let database = app.state::<Database>();
                let connection = database.get_connection();
                if let Err(error) = engine.synchronize_elasticsearch(&connection) {
                    warning = Some(error);
                }
            }
            Err(error) => warning = Some(error),
        }
    } else {
        log::warn!("Bundled Elasticsearch distribution was not found; using embedded search");
    }
    if let Some(error) = warning.as_ref() {
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
