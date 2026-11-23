//! Tells the build scripts of dependent crates which JavaScript engines this
//! build includes, as `DEP_FETCHLET_ENGINES` (a comma-separated list), so
//! they can offer APIs that start an `App` only when one is available. Sets
//! `fetchlet_web` when the build includes fetchlet-web's host Web APIs,
//! which every engine and the fuzzing harness do.

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    println!("cargo::rustc-check-cfg=cfg(fetchlet_web)");
    let feature = |name: &str| std::env::var_os(format!("CARGO_FEATURE_{name}")).is_some();
    if ["QUICKJS", "BOA", "V8", "FUZZING"].into_iter().any(feature) {
        println!("cargo::rustc-cfg=fetchlet_web");
    }
    let engines: Vec<&str> = ["quickjs", "boa", "v8"]
        .into_iter()
        .filter(|engine| {
            std::env::var_os(format!("CARGO_FEATURE_{}", engine.to_uppercase())).is_some()
        })
        .collect();
    println!("cargo::metadata=engines={}", engines.join(","));
}
