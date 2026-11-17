use std::fmt;

/// A relative path inside the workspace, written with `/` separators.
///
/// Parsing is the permission boundary for every API that names a file: a
/// valid path has only ordinary segments, so it cannot climb out of the
/// workspace, name a hidden file, or alias another file on Windows. The store
/// still resolves symbolic links before it opens anything.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct WorkspacePath(String);

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct InvalidPath(pub &'static str);

impl fmt::Display for InvalidPath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

/// Windows device names, refused on every platform so that a workspace
/// behaves the same wherever it is opened.
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

impl WorkspacePath {
    pub fn parse(value: &str) -> Result<Self, InvalidPath> {
        if value.is_empty() {
            return Err(InvalidPath("the path is empty"));
        }
        for segment in value.split('/') {
            check_segment(segment)?;
        }
        Ok(Self(value.to_owned()))
    }

    /// A Markdown note, which the index, search and editor handle.
    pub fn is_note(&self) -> bool {
        self.0.len() > 3 && self.0[self.0.len() - 3..].eq_ignore_ascii_case(".md")
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn segments(&self) -> impl Iterator<Item = &str> {
        self.0.split('/')
    }

    pub fn file_name(&self) -> &str {
        self.0.rsplit('/').next().unwrap_or(&self.0)
    }

    pub fn extension(&self) -> Option<&str> {
        self.file_name()
            .rsplit_once('.')
            .map(|(_, extension)| extension)
    }
}

fn check_segment(segment: &str) -> Result<(), InvalidPath> {
    if segment.is_empty() {
        return Err(InvalidPath("the path has an empty segment"));
    }
    if segment == "." || segment == ".." {
        return Err(InvalidPath("the path has a relative segment"));
    }
    if segment.starts_with('.') {
        return Err(InvalidPath("hidden files are outside the workspace"));
    }
    // Windows drops trailing dots and spaces, so `a.md.` would open `a.md`.
    if segment.ends_with('.') || segment.ends_with(' ') {
        return Err(InvalidPath("a segment ends with a dot or a space"));
    }
    if segment
        .chars()
        .any(|character| character.is_control() || "\\:*?\"<>|".contains(character))
    {
        return Err(InvalidPath("the path has a reserved character"));
    }
    let stem = segment.split('.').next().unwrap_or(segment);
    if RESERVED_NAMES
        .iter()
        .any(|name| stem.eq_ignore_ascii_case(name))
    {
        return Err(InvalidPath("the path names a device"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::WorkspacePath;

    #[test]
    fn accepts_ordinary_relative_paths() {
        for path in [
            "index.md",
            "guide/日本語.md",
            "a b/c-d_e.MD",
            "images/logo.png",
        ] {
            assert!(WorkspacePath::parse(path).is_ok(), "{path}");
        }
        assert!(WorkspacePath::parse("guide/a.MD").unwrap().is_note());
        assert!(!WorkspacePath::parse("images/logo.png").unwrap().is_note());
    }

    #[test]
    fn refuses_paths_that_leave_or_alias_the_workspace() {
        for path in [
            "",
            "/etc/passwd",
            "../secret.md",
            "a/../../secret.md",
            "a/./b.md",
            "a//b.md",
            "a\\..\\b.md",
            "C:/Windows/win.ini",
            "C:secret.md",
            ".git/config",
            "notes/.hidden.md",
            "note.md.",
            "note.md ",
            "nul.md",
            "dir/COM1",
            "a\0b.md",
            "a\nb.md",
            "a?.md",
        ] {
            assert!(WorkspacePath::parse(path).is_err(), "{path:?}");
        }
    }
}
