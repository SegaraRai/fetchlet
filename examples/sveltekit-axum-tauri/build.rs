use std::path::Path;

fn main() {
    // Only the desktop build reads tauri.conf.json and generates the Tauri context.
    #[cfg(feature = "desktop")]
    tauri_build::build();
    embed_frontend();
}

/// Embed the SvelteKit build (`vp build`) when it exists. A binary built
/// without it, as `cargo check` and clippy do, needs `build_directory` in its
/// configuration instead.
fn embed_frontend() {
    println!("cargo::rustc-check-cfg=cfg(mdw_embedded)");
    let manifest_directory = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let build = Path::new(&manifest_directory).join("build");
    let files = ["fetchlet.json", "server.js", "assets.flpk"];
    for file in files {
        println!("cargo::rerun-if-changed={}", build.join(file).display());
    }
    if files.iter().all(|file| build.join(file).is_file()) {
        println!("cargo::rustc-cfg=mdw_embedded");
        println!("cargo::rustc-env=MDW_FRONTEND={}", build.display());
    } else {
        println!(
            "cargo::warning=build/ has no SvelteKit build; mdw will need build_directory. Run `vp run build` first to embed it."
        );
    }
}
