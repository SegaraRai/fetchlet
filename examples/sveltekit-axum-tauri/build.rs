fn main() {
    // Only the desktop build reads tauri.conf.json and generates the Tauri context.
    #[cfg(feature = "desktop")]
    tauri_build::build();
}
