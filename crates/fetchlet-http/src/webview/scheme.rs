/// A custom URI scheme a webview loads the application from, such as one
/// registered with Tauri's `register_asynchronous_uri_scheme_protocol`.
///
/// WebView2 and Android serve a custom scheme as `http://<name>.localhost`;
/// the other platforms use `<name>://localhost`. The application sees
/// [`origin`](Self::origin) on every platform, so the absolute URLs it
/// renders stay the same.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WebviewScheme {
    name: &'static str,
}

impl WebviewScheme {
    /// The scheme `name`, such as `"app"`: lowercase ASCII letters, digits,
    /// `+`, `-` or `.`, starting with a letter, as URI schemes are.
    ///
    /// # Panics
    ///
    /// When `name` is not such a scheme; in a constant, at compile time.
    pub const fn new(name: &'static str) -> Self {
        let bytes = name.as_bytes();
        assert!(
            !bytes.is_empty() && bytes[0].is_ascii_lowercase(),
            "a webview scheme starts with a lowercase letter"
        );
        let mut index = 1;
        while index < bytes.len() {
            let byte = bytes[index];
            assert!(
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || byte == b'+'
                    || byte == b'-'
                    || byte == b'.',
                "a webview scheme holds lowercase letters, digits, '+', '-' and '.'"
            );
            index += 1;
        }
        Self { name }
    }

    /// The scheme's name, which the webview registers.
    pub const fn name(&self) -> &'static str {
        self.name
    }

    /// The origin the application sees: `http://<name>.localhost`.
    pub fn origin(&self) -> String {
        format!("http://{}.localhost", self.name)
    }

    /// The URL of the first page on this platform: `http://<name>.localhost/`
    /// on Windows and Android, `<name>://localhost/` elsewhere.
    pub fn start_url(&self) -> String {
        if cfg!(any(windows, target_os = "android")) {
            format!("http://{}.localhost/", self.name)
        } else {
            format!("{}://localhost/", self.name)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::WebviewScheme;

    #[test]
    fn the_origin_is_the_same_on_every_platform() {
        const SCHEME: WebviewScheme = WebviewScheme::new("app");
        assert_eq!(SCHEME.name(), "app");
        assert_eq!(SCHEME.origin(), "http://app.localhost");
        let expected = if cfg!(any(windows, target_os = "android")) {
            "http://app.localhost/"
        } else {
            "app://localhost/"
        };
        assert_eq!(SCHEME.start_url(), expected);
    }

    #[test]
    #[should_panic(expected = "lowercase")]
    fn a_name_that_is_no_scheme_is_refused() {
        WebviewScheme::new("App/");
    }
}
