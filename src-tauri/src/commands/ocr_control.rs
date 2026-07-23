use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct OcrTaskManager {
    tasks: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl OcrTaskManager {
    pub fn register(&self, task_id: &str) -> Result<OcrTaskRegistration<'_>, String> {
        let mut tasks = self
            .tasks
            .lock()
            .expect("OCR task registry lock poisoned");
        if tasks.contains_key(task_id) {
            return Err(format!("OCR task '{task_id}' is already running"));
        }
        let flag = Arc::new(AtomicBool::new(false));
        tasks.insert(task_id.to_string(), flag.clone());
        Ok(OcrTaskRegistration {
            manager: self,
            task_id: task_id.to_string(),
            flag,
        })
    }

    pub fn cancel(&self, task_id: &str) -> bool {
        let flag = self
            .tasks
            .lock()
            .expect("OCR task registry lock poisoned")
            .get(task_id)
            .cloned();
        if let Some(flag) = flag {
            flag.store(true, Ordering::Release);
            true
        } else {
            false
        }
    }

    pub fn cancel_all(&self) -> usize {
        let flags = self
            .tasks
            .lock()
            .expect("OCR task registry lock poisoned")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for flag in &flags {
            flag.store(true, Ordering::Release);
        }
        flags.len()
    }

    fn finish(&self, task_id: &str) {
        self.tasks
            .lock()
            .expect("OCR task registry lock poisoned")
            .remove(task_id);
    }
}

pub struct OcrTaskRegistration<'a> {
    manager: &'a OcrTaskManager,
    task_id: String,
    flag: Arc<AtomicBool>,
}

impl OcrTaskRegistration<'_> {
    pub fn cancellation_flag(&self) -> Arc<AtomicBool> {
        self.flag.clone()
    }
}

impl Drop for OcrTaskRegistration<'_> {
    fn drop(&mut self) {
        self.manager.finish(&self.task_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_reaches_registered_task_and_cleanup_removes_it() {
        let manager = OcrTaskManager::default();
        {
            let registration = manager.register("task-1").unwrap();
            assert!(!registration.cancellation_flag().load(Ordering::Acquire));
            assert!(manager.register("task-1").is_err());
            assert!(manager.cancel("task-1"));
            assert!(registration.cancellation_flag().load(Ordering::Acquire));
        }
        assert!(!manager.cancel("task-1"));
    }

    #[test]
    fn cancellation_reaches_all_registered_tasks() {
        let manager = OcrTaskManager::default();
        let first = manager.register("task-1").unwrap();
        let second = manager.register("task-2").unwrap();

        assert_eq!(manager.cancel_all(), 2);
        assert!(first.cancellation_flag().load(Ordering::Acquire));
        assert!(second.cancellation_flag().load(Ordering::Acquire));
    }
}
