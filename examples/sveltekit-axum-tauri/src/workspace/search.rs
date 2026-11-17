use serde::Serialize;
use utoipa::ToSchema;

use super::index::{Entry, Index};

/// Characters of context kept before the first match in a snippet.
const CONTEXT_BEFORE: usize = 40;
/// Characters a snippet spans from its start.
const SNIPPET_LENGTH: usize = 160;
/// Weight of a title match against one body match.
const TITLE_WEIGHT: usize = 10;

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct SearchHit {
    pub path: String,
    pub title: String,
    pub score: usize,
    /// Excerpt around the first match, split into plain and matched parts so
    /// the page can mark matches without handling HTML.
    pub snippet: Vec<SnippetPart>,
}

#[derive(Debug, PartialEq, Serialize, ToSchema)]
pub(crate) struct SnippetPart {
    pub text: String,
    pub matched: bool,
}

/// Case-insensitive search in which every whitespace-separated term must
/// appear in the title or the body. Substring matching serves languages
/// without spaces between words, such as Japanese.
pub(crate) fn search(index: &Index, query: &str, limit: usize) -> Vec<SearchHit> {
    let terms: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    if terms.is_empty() {
        return Vec::new();
    }
    let mut hits: Vec<SearchHit> = index
        .entries
        .values()
        .filter_map(|entry| score(entry, &terms).map(|score| (entry, score)))
        .map(|(entry, score)| SearchHit {
            path: entry.summary.path.clone(),
            title: entry.summary.title.clone(),
            score,
            snippet: snippet(entry, &terms),
        })
        .collect();
    hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    hits.truncate(limit);
    hits
}

fn score(entry: &Entry, terms: &[String]) -> Option<usize> {
    let title = entry.summary.title.to_lowercase();
    let mut total = 0;
    for term in terms {
        let in_title = title.matches(term.as_str()).count();
        let in_body = entry.folded.matches(term.as_str()).count();
        if in_title + in_body == 0 {
            return None;
        }
        total += in_title * TITLE_WEIGHT + in_body;
    }
    Some(total)
}

/// Byte ranges of `content` that match a term, merged and in order.
fn matches(entry: &Entry, terms: &[String]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    for term in terms {
        for (start, found) in entry.folded.match_indices(term.as_str()) {
            let end = start + found.len();
            let original_start = entry.offsets[start];
            let original_end = entry
                .offsets
                .get(end)
                .copied()
                .unwrap_or(entry.content.len());
            // A term can end inside a character that lowercases to several.
            let original_end = original_end.max(original_start + 1);
            ranges.push((original_start, ceil_char(&entry.content, original_end)));
        }
    }
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in ranges {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
}

fn snippet(entry: &Entry, terms: &[String]) -> Vec<SnippetPart> {
    let content = &entry.content;
    let ranges = matches(entry, terms);
    let first = ranges.first().map_or(0, |range| range.0);
    let start = content[..first]
        .char_indices()
        .rev()
        .nth(CONTEXT_BEFORE - 1)
        .map_or(0, |(offset, _)| offset);
    let end = content[start..]
        .char_indices()
        .nth(SNIPPET_LENGTH)
        .map_or(content.len(), |(offset, _)| start + offset);

    let mut parts = Vec::new();
    let mut cursor = start;
    for (match_start, match_end) in ranges {
        if match_end <= start || match_start >= end {
            continue;
        }
        let match_start = match_start.max(start);
        let match_end = match_end.min(end);
        push(&mut parts, &content[cursor..match_start], false);
        push(&mut parts, &content[match_start..match_end], true);
        cursor = match_end;
    }
    push(&mut parts, &content[cursor..end], false);
    parts
}

fn push(parts: &mut Vec<SnippetPart>, text: &str, matched: bool) {
    let text = text.replace(['\r', '\n'], " ");
    if !text.is_empty() {
        parts.push(SnippetPart { text, matched });
    }
}

fn ceil_char(text: &str, mut offset: usize) -> usize {
    while offset < text.len() && !text.is_char_boundary(offset) {
        offset += 1;
    }
    offset
}

#[cfg(test)]
mod tests {
    use super::super::index::{Entry, Index};
    use super::super::path::WorkspacePath;
    use super::{SnippetPart, search};

    fn index(notes: &[(&str, &str)]) -> Index {
        let mut index = Index::default();
        for (path, content) in notes {
            let path = WorkspacePath::parse(path).unwrap();
            let entry = Entry::new(&path, (*content).to_owned(), 0);
            index.entries.insert(path, entry);
        }
        index
    }

    #[test]
    fn requires_every_term_and_ranks_titles_first() {
        let index = index(&[
            ("a.md", "# Rust notes\nownership and borrowing"),
            ("b.md", "# Other\nRust appears in the body. rust again"),
            ("c.md", "# Rust only\nnothing else"),
        ]);
        let hits = search(&index, "rust borrowing", 10);
        assert_eq!(
            hits.iter().map(|hit| hit.path.as_str()).collect::<Vec<_>>(),
            ["a.md"]
        );
        let hits = search(&index, "RUST", 10);
        assert_eq!(hits[0].path, "a.md");
        assert_eq!(hits.len(), 3);
        assert!(search(&index, "   ", 10).is_empty());
        assert_eq!(search(&index, "rust", 1).len(), 1);
    }

    #[test]
    fn snippets_mark_matches_in_the_original_text() {
        let index = index(&[("j.md", "# Journal\nÉté: Rust rendered Markdown today.")]);
        let hits = search(&index, "markdown", 10);
        let matched: Vec<&SnippetPart> =
            hits[0].snippet.iter().filter(|part| part.matched).collect();
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].text, "Markdown");
        let text: String = hits[0]
            .snippet
            .iter()
            .map(|part| part.text.as_str())
            .collect();
        assert!(text.contains("Été: Rust rendered"), "{text}");
    }
}
