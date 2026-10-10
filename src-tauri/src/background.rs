use tauri::{AppHandle, Manager, State};

/// Keep filesystem I/O and database lock waits off both the UI and async workers.
pub async fn run<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("Background task failed: {error}"))?
}

pub fn state<T: Send + Sync + 'static>(app: &AppHandle) -> Result<State<'_, T>, String> {
    app.try_state::<T>()
        .ok_or_else(|| "Application is still initializing; please try again shortly".to_string())
}

#[cfg(test)]
mod tests {
    #[tokio::test(flavor = "current_thread")]
    async fn blocking_work_leaves_the_caller_free_and_propagates_errors() {
        let caller = std::thread::current().id();
        let worker = super::run(|| Ok(std::thread::current().id()))
            .await
            .unwrap();
        assert_ne!(caller, worker);
        assert_eq!(
            super::run(|| Err::<(), _>("disk failure".into()))
                .await
                .unwrap_err(),
            "disk failure"
        );
    }
}
