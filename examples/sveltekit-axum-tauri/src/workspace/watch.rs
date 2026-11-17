use std::path::{Component, Path};
use std::sync::Arc;
use std::sync::mpsc::{RecvTimeoutError, channel};
use std::time::Duration;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};

use super::native::without_verbatim_prefix;
use super::store::Workspace;

/// Watches the workspace directory and rescans it after a burst of changes.
/// Dropping the returned watcher stops the watch and its thread.
pub(crate) fn watch(
    workspace: Arc<Workspace>,
    debounce: Duration,
) -> notify::Result<RecommendedWatcher> {
    let (sender, receiver) = channel::<()>();
    let root = without_verbatim_prefix(workspace.root());
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
        if let Ok(event) = event
            && event.paths.iter().any(|path| is_relevant(&root, path))
        {
            let _ = sender.send(());
        }
    })?;
    watcher.watch(
        &without_verbatim_prefix(workspace.root()),
        RecursiveMode::Recursive,
    )?;

    std::thread::Builder::new()
        .name("mdw-watch".into())
        .spawn(move || {
            while receiver.recv().is_ok() {
                // Wait until the directory is quiet so that one save, which
                // editors often perform as several operations, rescans once.
                loop {
                    match receiver.recv_timeout(debounce) {
                        Ok(()) => continue,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                if let Err(error) = workspace.rescan() {
                    eprintln!("workspace rescan failed: {error:#}");
                }
            }
        })
        .map_err(notify::Error::io)?;
    Ok(watcher)
}

/// Changes under hidden directories such as `.git`, and the application's
/// own temporary files, do not affect the notes.
fn is_relevant(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    relative.components().all(|component| match component {
        Component::Normal(name) => {
            let name = name.to_string_lossy();
            !name.starts_with('.') && name != "node_modules" && name != "target"
        }
        _ => true,
    })
}
