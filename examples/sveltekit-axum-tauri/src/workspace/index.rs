use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use sha2::{Digest, Sha256};
use utoipa::ToSchema;

use super::path::WorkspacePath;

/// Directories that hold tooling output rather than notes.
const SKIPPED_DIRECTORIES: [&str; 2] = ["node_modules", "target"];

/// Budgets the workspace applies while it reads files.
#[derive(Clone, Copy, Debug)]
pub(crate) struct WorkspaceLimits {
    pub note_bytes: usize,
    pub notes: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, ToSchema)]
pub(crate) struct NoteSummary {
    /// Workspace path with `/` separators.
    pub path: String,
    pub title: String,
    /// Last modification, in milliseconds since the Unix epoch.
    pub modified: u64,
    pub size: u64,
}

/// One indexed note. The lowercase text and its byte offsets let search match
/// without case and still cut snippets from the original text.
#[derive(Clone)]
pub(crate) struct Entry {
    pub summary: NoteSummary,
    pub version: String,
    pub content: String,
    pub folded: String,
    /// For each byte of `folded`, the offset of its character in `content`.
    pub offsets: Vec<usize>,
}

impl Entry {
    pub fn new(path: &WorkspacePath, content: String, modified: u64) -> Self {
        let (folded, offsets) = fold(&content);
        Self {
            summary: NoteSummary {
                path: path.as_str().to_owned(),
                title: title_of(path, &content),
                modified,
                size: content.len() as u64,
            },
            version: version_of(content.as_bytes()),
            content,
            folded,
            offsets,
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct Index {
    pub entries: BTreeMap<WorkspacePath, Entry>,
    /// Notes left out because they exceed the size budget or are not UTF-8.
    pub skipped: usize,
}

impl Index {
    /// Scans `root`, reusing entries of `previous` whose size and modification
    /// time are unchanged, so a rescan reads only the files that changed.
    pub fn scan(root: &Path, limits: WorkspaceLimits, previous: &Index) -> anyhow::Result<Self> {
        let mut index = Index::default();
        let mut pending = vec![(root.to_path_buf(), String::new())];
        while let Some((directory, prefix)) = pending.pop() {
            for item in fs::read_dir(&directory)? {
                let item = item?;
                let name = item.file_name();
                let Some(name) = name.to_str() else { continue };
                let relative = if prefix.is_empty() {
                    name.to_owned()
                } else {
                    format!("{prefix}/{name}")
                };
                let Ok(path) = WorkspacePath::parse(&relative) else {
                    continue;
                };
                // Symbolic links are not followed: the index covers only
                // files that are physically inside the workspace.
                let kind = item.file_type()?;
                if kind.is_dir() {
                    if !SKIPPED_DIRECTORIES.contains(&name) {
                        pending.push((item.path(), relative));
                    }
                    continue;
                }
                if !kind.is_file() || !path.is_note() {
                    continue;
                }
                let metadata = item.metadata()?;
                let modified = modified_millis(&metadata);
                if let Some(entry) = previous.entries.get(&path)
                    && entry.summary.modified == modified
                    && entry.summary.size == metadata.len()
                {
                    index.insert(path, entry.clone(), limits)?;
                    continue;
                }
                if metadata.len() > limits.note_bytes as u64 {
                    index.skipped += 1;
                    continue;
                }
                match String::from_utf8(fs::read(item.path())?) {
                    Ok(content) => {
                        index.insert(path.clone(), Entry::new(&path, content, modified), limits)?
                    }
                    Err(_) => index.skipped += 1,
                }
            }
        }
        Ok(index)
    }

    pub fn insert(
        &mut self,
        path: WorkspacePath,
        entry: Entry,
        limits: WorkspaceLimits,
    ) -> anyhow::Result<()> {
        if !self.entries.contains_key(&path) && self.entries.len() >= limits.notes {
            anyhow::bail!(
                "the workspace has more than {} notes; raise workspace_notes in the configuration",
                limits.notes
            );
        }
        self.entries.insert(path, entry);
        Ok(())
    }

    /// Paths whose presence or version differs between the two indexes.
    pub fn changed_paths(&self, other: &Index) -> Vec<String> {
        let mut changed: Vec<String> = self
            .entries
            .iter()
            .filter(|(path, entry)| {
                other
                    .entries
                    .get(path)
                    .is_none_or(|before| before.version != entry.version)
            })
            .map(|(path, _)| path.as_str().to_owned())
            .collect();
        changed.extend(
            other
                .entries
                .keys()
                .filter(|path| !self.entries.contains_key(path))
                .map(|path| path.as_str().to_owned()),
        );
        changed.sort();
        changed
    }
}

pub(crate) fn modified_millis(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis() as u64)
}

/// A content version for optimistic concurrency: the SHA-256 of the bytes.
pub(crate) fn version_of(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The front matter `title`, else the first level-one heading, else the file name.
fn title_of(path: &WorkspacePath, content: &str) -> String {
    let mut body = content;
    if let Some(rest) = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))
        && let Some(end) = rest.find("\n---")
    {
        let front = &rest[..end];
        for line in front.lines() {
            if let Some(value) = line.strip_prefix("title:") {
                let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
                if !value.is_empty() {
                    return value.to_owned();
                }
            }
        }
        body = &rest[end + 4..];
    }
    let mut fenced = false;
    for line in body.lines() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
        } else if !fenced && let Some(heading) = line.strip_prefix("# ") {
            let heading = heading.trim();
            if !heading.is_empty() {
                return heading.to_owned();
            }
        }
    }
    let name = path.file_name();
    name[..name.len() - 3].to_owned()
}

fn fold(content: &str) -> (String, Vec<usize>) {
    let mut folded = String::with_capacity(content.len());
    let mut offsets = Vec::with_capacity(content.len());
    for (offset, character) in content.char_indices() {
        for lower in character.to_lowercase() {
            folded.push(lower);
            offsets.resize(folded.len(), offset);
        }
    }
    (folded, offsets)
}

#[cfg(test)]
mod tests {
    use super::{WorkspacePath, fold, title_of};

    fn title(path: &str, content: &str) -> String {
        title_of(&WorkspacePath::parse(path).unwrap(), content)
    }

    #[test]
    fn titles_come_from_front_matter_then_heading_then_file_name() {
        assert_eq!(title("a.md", "---\ntitle: \"Plan\"\n---\n# Other"), "Plan");
        assert_eq!(
            title("a.md", "intro\n```\n# not this\n```\n# Heading\n"),
            "Heading"
        );
        assert_eq!(title("dir/café.md", "no heading"), "café");
    }

    #[test]
    fn folding_maps_lowercase_bytes_back_to_the_original() {
        let (folded, offsets) = fold("Aİb");
        assert_eq!(folded, "ai\u{307}b");
        assert_eq!(offsets.len(), folded.len());
        // Every byte of the expanded `İ` points at its start in the original.
        assert_eq!(offsets[1], 1);
        assert_eq!(*offsets.last().unwrap(), 3);
    }
}
