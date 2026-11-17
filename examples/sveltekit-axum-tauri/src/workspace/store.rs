use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};

use serde::Serialize;
use tokio::sync::broadcast;
use utoipa::ToSchema;

use super::index::{Entry, Index, NoteSummary, WorkspaceLimits, modified_millis, version_of};
use super::native::without_verbatim_prefix;
use super::path::{InvalidPath, WorkspacePath};
use super::search::{SearchHit, search};

/// Change notifications kept for subscribers that fall behind. A subscriber
/// that misses some still sees a later revision and refreshes everything.
const CHANGE_BACKLOG: usize = 16;

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct Note {
    pub path: String,
    pub title: String,
    pub content: String,
    /// SHA-256 of the content. Saving requires the version it was based on.
    pub version: String,
    pub modified: u64,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct WorkspaceInfo {
    /// The workspace directory's name.
    pub name: String,
    /// Increases whenever the set of notes or a note's content changes.
    pub revision: u64,
    pub notes: usize,
    /// Notes left out for exceeding the size budget or not being UTF-8.
    pub skipped: usize,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub(crate) struct Change {
    pub revision: u64,
    /// Notes that were added, changed or removed.
    pub paths: Vec<String>,
}

#[derive(Debug)]
pub(crate) enum WorkspaceError {
    InvalidPath(InvalidPath),
    NotANote,
    NotFound,
    /// The note changed since the version the caller based its edit on, or
    /// it already exists when the caller meant to create it.
    Conflict {
        current: Option<String>,
    },
    TooLarge {
        limit: usize,
    },
    Io(io::Error),
}

impl From<io::Error> for WorkspaceError {
    fn from(error: io::Error) -> Self {
        if error.kind() == io::ErrorKind::NotFound {
            Self::NotFound
        } else {
            Self::Io(error)
        }
    }
}

impl From<InvalidPath> for WorkspaceError {
    fn from(error: InvalidPath) -> Self {
        Self::InvalidPath(error)
    }
}

/// A directory of Markdown notes with an in-memory index for listing and
/// search. Reads go to the disk, so a note is current even before the
/// watcher reindexes it.
pub(crate) struct Workspace {
    root: PathBuf,
    name: String,
    limits: WorkspaceLimits,
    index: RwLock<Index>,
    revision: AtomicU64,
    changes: broadcast::Sender<Change>,
    /// Serializes check-then-write sequences of saves and deletes.
    writes: Mutex<()>,
}

impl Workspace {
    pub fn open(root: &Path, limits: WorkspaceLimits) -> anyhow::Result<Self> {
        let root = fs::canonicalize(root)
            .map_err(|error| anyhow::anyhow!("open workspace {}: {error}", root.display()))?;
        anyhow::ensure!(root.is_dir(), "{} is not a directory", root.display());
        let name = root.file_name().map_or_else(
            || root.display().to_string(),
            |name| name.to_string_lossy().into_owned(),
        );
        let index = Index::scan(&root, limits, &Index::default())?;
        Ok(Self {
            root,
            name,
            limits,
            index: RwLock::new(index),
            revision: AtomicU64::new(1),
            changes: broadcast::channel(CHANGE_BACKLOG).0,
            writes: Mutex::new(()),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The root as people write it, without the Windows `\\?\` prefix.
    pub fn display_root(&self) -> PathBuf {
        without_verbatim_prefix(&self.root)
    }

    pub fn info(&self) -> WorkspaceInfo {
        let index = self.index.read().unwrap();
        WorkspaceInfo {
            name: self.name.clone(),
            revision: self.revision.load(Ordering::SeqCst),
            notes: index.entries.len(),
            skipped: index.skipped,
        }
    }

    pub fn list(&self) -> Vec<NoteSummary> {
        let index = self.index.read().unwrap();
        index
            .entries
            .values()
            .map(|entry| entry.summary.clone())
            .collect()
    }

    pub fn search(&self, query: &str, limit: usize) -> Vec<SearchHit> {
        search(&self.index.read().unwrap(), query, limit)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Change> {
        self.changes.subscribe()
    }

    pub fn read(&self, path: &WorkspacePath) -> Result<Note, WorkspaceError> {
        if !path.is_note() {
            return Err(WorkspaceError::NotANote);
        }
        let location = self.existing(path)?;
        let metadata = fs::metadata(&location)?;
        if metadata.len() > self.limits.note_bytes as u64 {
            return Err(WorkspaceError::TooLarge {
                limit: self.limits.note_bytes,
            });
        }
        let content = String::from_utf8(fs::read(&location)?).map_err(|_| {
            WorkspaceError::Io(io::Error::new(
                io::ErrorKind::InvalidData,
                "the note is not UTF-8",
            ))
        })?;
        let entry = Entry::new(path, content, modified_millis(&metadata));
        Ok(note(entry))
    }

    /// Reads any file of the workspace, such as an image a note embeds.
    pub fn read_file(&self, path: &WorkspacePath, limit: usize) -> Result<Vec<u8>, WorkspaceError> {
        let location = self.existing(path)?;
        let metadata = fs::metadata(&location)?;
        if !metadata.is_file() {
            return Err(WorkspaceError::NotFound);
        }
        if metadata.len() > limit as u64 {
            return Err(WorkspaceError::TooLarge { limit });
        }
        Ok(fs::read(location)?)
    }

    /// Writes a note. `base` is the version the edit started from, or None to
    /// create a note that must not exist yet.
    pub fn save(
        &self,
        path: &WorkspacePath,
        content: &str,
        base: Option<&str>,
    ) -> Result<Note, WorkspaceError> {
        if !path.is_note() {
            return Err(WorkspaceError::NotANote);
        }
        if content.len() > self.limits.note_bytes {
            return Err(WorkspaceError::TooLarge {
                limit: self.limits.note_bytes,
            });
        }
        let _write = self.writes.lock().unwrap();
        let current = self.current_version(path)?;
        if current.as_deref() != base {
            return Err(WorkspaceError::Conflict { current });
        }
        let location = self.writable(path)?;
        write_atomically(&location, content.as_bytes())?;
        let metadata = fs::metadata(&location)?;
        let entry = Entry::new(path, content.to_owned(), modified_millis(&metadata));
        let saved = note(entry.clone());
        self.update(|index| index.insert(path.clone(), entry, self.limits))?;
        Ok(saved)
    }

    pub fn delete(&self, path: &WorkspacePath, version: &str) -> Result<(), WorkspaceError> {
        if !path.is_note() {
            return Err(WorkspaceError::NotANote);
        }
        let _write = self.writes.lock().unwrap();
        let current = self.current_version(path)?;
        match current.as_deref() {
            None => return Err(WorkspaceError::NotFound),
            Some(current) if current != version => {
                return Err(WorkspaceError::Conflict {
                    current: Some(current.to_owned()),
                });
            }
            Some(_) => {}
        }
        fs::remove_file(self.existing(path)?)?;
        self.update(|index| {
            index.entries.remove(path);
            Ok(())
        })?;
        Ok(())
    }

    /// Rescans the directory after outside changes and announces the notes
    /// that differ. A rescan that finds nothing new announces nothing, so the
    /// echo of the application's own save stays quiet.
    pub fn rescan(&self) -> anyhow::Result<()> {
        let previous = self.index.read().unwrap().clone();
        let next = Index::scan(&self.root, self.limits, &previous)?;
        self.replace(previous, next);
        Ok(())
    }

    fn update(
        &self,
        change: impl FnOnce(&mut Index) -> anyhow::Result<()>,
    ) -> Result<(), WorkspaceError> {
        let previous = self.index.read().unwrap().clone();
        let mut next = previous.clone();
        change(&mut next)
            .map_err(|error| WorkspaceError::Io(io::Error::other(error.to_string())))?;
        self.replace(previous, next);
        Ok(())
    }

    fn replace(&self, previous: Index, next: Index) {
        let paths = next.changed_paths(&previous);
        *self.index.write().unwrap() = next;
        if paths.is_empty() {
            return;
        }
        let revision = self.revision.fetch_add(1, Ordering::SeqCst) + 1;
        // No receiver is an ordinary state: nobody has a page open.
        let _ = self.changes.send(Change { revision, paths });
    }

    fn current_version(&self, path: &WorkspacePath) -> Result<Option<String>, WorkspaceError> {
        match self.existing(path) {
            Ok(location) => Ok(Some(version_of(&fs::read(location)?))),
            Err(WorkspaceError::NotFound) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// The canonical location of an existing file, refused when a symbolic
    /// link resolves outside the workspace.
    fn existing(&self, path: &WorkspacePath) -> Result<PathBuf, WorkspaceError> {
        let location = fs::canonicalize(self.join(path))?;
        if !location.starts_with(&self.root) {
            return Err(WorkspaceError::NotFound);
        }
        Ok(location)
    }

    /// The location to write `path`, creating missing parent directories.
    /// Every existing ancestor must resolve inside the workspace.
    fn writable(&self, path: &WorkspacePath) -> Result<PathBuf, WorkspaceError> {
        let location = self.join(path);
        let parent = location.parent().expect("a workspace path has a parent");
        let mut existing = parent;
        while !existing.exists() {
            existing = existing.parent().expect("the workspace root exists");
        }
        if !fs::canonicalize(existing)?.starts_with(&self.root) {
            return Err(WorkspaceError::NotFound);
        }
        fs::create_dir_all(parent)?;
        if let Ok(metadata) = fs::symlink_metadata(&location)
            && !metadata.is_file()
        {
            return Err(WorkspaceError::NotANote);
        }
        Ok(location)
    }

    fn join(&self, path: &WorkspacePath) -> PathBuf {
        path.segments()
            .fold(self.root.clone(), |location, segment| {
                location.join(segment)
            })
    }
}

fn note(entry: Entry) -> Note {
    Note {
        path: entry.summary.path,
        title: entry.summary.title,
        content: entry.content,
        version: entry.version,
        modified: entry.summary.modified,
    }
}

/// Writes a sibling temporary file and renames it over the target, so an
/// editor or the watcher never reads a half-written note.
fn write_atomically(location: &Path, bytes: &[u8]) -> io::Result<()> {
    let name = location
        .file_name()
        .expect("a note has a file name")
        .to_string_lossy();
    let temporary = location.with_file_name(format!(".{name}.mdw-{}", std::process::id()));
    let result = (|| {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, location)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::super::index::WorkspaceLimits;
    use super::super::path::WorkspacePath;
    use super::{Workspace, WorkspaceError};

    const LIMITS: WorkspaceLimits = WorkspaceLimits {
        note_bytes: 64,
        notes: 4,
    };

    struct Fixture {
        directory: PathBuf,
        workspace: Workspace,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let directory =
                std::env::temp_dir().join(format!("mdw-store-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&directory);
            let root = directory.join("notes");
            fs::create_dir_all(root.join("guide")).unwrap();
            fs::write(root.join("index.md"), "# Home\n").unwrap();
            fs::write(root.join("guide/start.md"), "# Start\n").unwrap();
            fs::write(directory.join("outside.md"), "# Secret\n").unwrap();
            let workspace = Workspace::open(&root, LIMITS).unwrap();
            Self {
                directory,
                workspace,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    fn path(value: &str) -> WorkspacePath {
        WorkspacePath::parse(value).unwrap()
    }

    #[test]
    fn saves_with_optimistic_concurrency() {
        let fixture = Fixture::new("concurrency");
        let workspace = &fixture.workspace;
        let note = workspace.read(&path("index.md")).unwrap();
        let mut changes = workspace.subscribe();

        let saved = workspace
            .save(&path("index.md"), "# Home 2\n", Some(&note.version))
            .unwrap();
        assert_eq!(saved.title, "Home 2");
        assert_eq!(changes.try_recv().unwrap().paths, ["index.md"]);
        // A second save based on the old version is a conflict that names the current one.
        match workspace.save(&path("index.md"), "# Lost\n", Some(&note.version)) {
            Err(WorkspaceError::Conflict { current }) => {
                assert_eq!(current, Some(saved.version.clone()))
            }
            other => panic!("{other:?}"),
        }
        // Creating requires that the note does not exist.
        assert!(matches!(
            workspace.save(&path("index.md"), "x", None),
            Err(WorkspaceError::Conflict { .. })
        ));
        workspace
            .save(&path("new/deep/note.md"), "# New\n", None)
            .unwrap();
        assert!(fixture.directory.join("notes/new/deep/note.md").is_file());
        assert_eq!(workspace.info().notes, 3);

        workspace
            .delete(
                &path("new/deep/note.md"),
                &workspace.read(&path("new/deep/note.md")).unwrap().version,
            )
            .unwrap();
        assert_eq!(workspace.info().notes, 2);
        // No temporary file is left behind.
        let names: Vec<_> = fs::read_dir(fixture.directory.join("notes"))
            .unwrap()
            .map(|item| item.unwrap().file_name())
            .collect();
        assert!(
            names
                .iter()
                .all(|name| !name.to_string_lossy().contains("mdw-")),
            "{names:?}"
        );
    }

    #[test]
    fn applies_the_size_and_count_budgets() {
        let fixture = Fixture::new("budgets");
        let workspace = &fixture.workspace;
        let large = "x".repeat(LIMITS.note_bytes + 1);
        assert!(matches!(
            workspace.save(&path("large.md"), &large, None),
            Err(WorkspaceError::TooLarge { .. })
        ));
        workspace.save(&path("a.md"), "a", None).unwrap();
        workspace.save(&path("b.md"), "b", None).unwrap();
        // The fifth note exceeds the index budget of four.
        assert!(workspace.save(&path("c.md"), "c", None).is_err());
        fs::write(fixture.directory.join("notes/huge.md"), &large).unwrap();
        workspace.rescan().unwrap_err();
    }

    #[test]
    fn rescans_announce_only_real_changes() {
        let fixture = Fixture::new("rescan");
        let workspace = &fixture.workspace;
        let mut changes = workspace.subscribe();
        workspace.rescan().unwrap();
        assert!(changes.try_recv().is_err());
        fs::write(
            fixture.directory.join("notes/guide/start.md"),
            "# Changed\n",
        )
        .unwrap();
        fs::remove_file(fixture.directory.join("notes/index.md")).unwrap();
        workspace.rescan().unwrap();
        let change = changes.try_recv().unwrap();
        assert_eq!(change.paths, ["guide/start.md", "index.md"]);
        assert_eq!(change.revision, workspace.info().revision);
    }

    #[test]
    fn refuses_files_reached_through_links_outside_the_workspace() {
        let fixture = Fixture::new("links");
        let root = fixture.directory.join("notes");
        let outside = fixture.directory.join("outside.md");
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside, root.join("link.md")).is_ok()
            && std::os::unix::fs::symlink(&fixture.directory, root.join("up")).is_ok();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&outside, root.join("link.md")).is_ok()
            && std::os::windows::fs::symlink_dir(&fixture.directory, root.join("up")).is_ok();
        if !linked {
            // Creating symbolic links needs a privilege Windows grants only to
            // administrators and developer mode.
            eprintln!("skipped: symbolic links are unavailable");
            return;
        }
        let workspace = &fixture.workspace;
        assert!(matches!(
            workspace.read(&path("link.md")),
            Err(WorkspaceError::NotFound)
        ));
        assert!(matches!(
            workspace.read(&path("up/outside.md")),
            Err(WorkspaceError::NotFound)
        ));
        assert!(
            workspace
                .save(&path("up/outside.md"), "# Overwritten\n", None)
                .is_err()
        );
        assert!(
            workspace
                .save(&path("up/created.md"), "# Created\n", None)
                .is_err()
        );
        assert_eq!(fs::read_to_string(&outside).unwrap(), "# Secret\n");
        assert!(!fixture.directory.join("created.md").exists());
        // The index does not follow links either.
        workspace.rescan().unwrap();
        assert!(
            workspace
                .list()
                .iter()
                .all(|note| !note.path.contains("link") && !note.path.starts_with("up/"))
        );
    }
}
