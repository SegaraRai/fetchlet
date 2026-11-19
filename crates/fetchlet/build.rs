//! Tells the build scripts of dependent crates which JavaScript engines this
//! build includes, as `DEP_FETCHLET_ENGINES` (a comma-separated list), so
//! they can offer APIs that start an `App` only when one is available.

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    let engines: Vec<&str> = ["quickjs", "boa", "v8"]
        .into_iter()
        .filter(|engine| {
            std::env::var_os(format!("CARGO_FEATURE_{}", engine.to_uppercase())).is_some()
        })
        .collect();
    println!("cargo::metadata=engines={}", engines.join(","));
}
