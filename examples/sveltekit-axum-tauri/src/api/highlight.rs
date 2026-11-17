use std::sync::OnceLock;

use syntect::html::{ClassStyle, ClassedHTMLGenerator, css_for_theme_with_class_style};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;
use two_face::theme::EmbeddedThemeName;

/// Prefix of the CSS classes in highlighted code, kept apart from page styles.
const CLASS_STYLE: ClassStyle = ClassStyle::SpacedPrefixed { prefix: "hl-" };

/// Syntax highlighting with syntect and the grammars that bat ships. Server
/// JavaScript calls it through the in-process API while it renders a note,
/// so highlighting runs as native code in the same process.
pub(crate) struct Highlighter {
    syntaxes: OnceLock<SyntaxSet>,
    stylesheet: OnceLock<String>,
}

impl Highlighter {
    pub const fn new() -> Self {
        Self {
            syntaxes: OnceLock::new(),
            stylesheet: OnceLock::new(),
        }
    }

    /// Loads the grammars and the stylesheet ahead of the first request.
    pub fn warm_up(&self) {
        self.syntaxes.get_or_init(two_face::syntax::extra_newlines);
        self.stylesheet();
    }

    /// Highlighted HTML for `code`, or None when no grammar matches `language`.
    /// The generator escapes the source text.
    pub fn highlight(&self, code: &str, language: &str) -> Option<String> {
        let syntaxes = self.syntaxes.get_or_init(two_face::syntax::extra_newlines);
        let syntax = syntaxes.find_syntax_by_token(language)?;
        let mut generator =
            ClassedHTMLGenerator::new_with_class_style(syntax, syntaxes, CLASS_STYLE);
        for line in LinesWithEndings::from(code) {
            generator
                .parse_html_for_line_which_includes_newline(line)
                .ok()?;
        }
        Some(generator.finalize())
    }

    /// Colors for the highlight classes: a light theme, and a dark theme for
    /// pages that follow a dark color scheme.
    pub fn stylesheet(&self) -> &str {
        self.stylesheet.get_or_init(|| {
            let themes = two_face::theme::extra();
            let light =
                css_for_theme_with_class_style(themes.get(EmbeddedThemeName::Github), CLASS_STYLE)
                    .expect("the embedded theme converts to CSS");
            let dark = css_for_theme_with_class_style(
                themes.get(EmbeddedThemeName::OneHalfDark),
                CLASS_STYLE,
            )
            .expect("the embedded theme converts to CSS");
            format!("{light}\n@media (prefers-color-scheme: dark) {{\n{dark}\n}}\n")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::Highlighter;

    #[test]
    fn highlights_known_languages_and_escapes_the_source() {
        let highlighter = Highlighter::new();
        let html = highlighter.highlight("let x = \"<b>\";\n", "rust").unwrap();
        assert!(html.contains("hl-"), "{html}");
        assert!(html.contains("&lt;b&gt;"), "{html}");
        assert!(!html.contains("<b>"), "{html}");
        for language in ["ts", "typescript", "toml", "json", "bash", "py"] {
            assert!(highlighter.highlight("x", language).is_some(), "{language}");
        }
        assert!(highlighter.highlight("x", "no-such-language").is_none());
        assert!(
            highlighter
                .stylesheet()
                .contains("prefers-color-scheme: dark")
        );
    }
}
