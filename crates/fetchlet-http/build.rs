//! Sets `fetchlet_engine` when the fetchlet crate is built with a JavaScript
//! engine, which `Server` needs to start the application. The engine is
//! chosen on the fetchlet crate, so this crate reads its build metadata.

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    println!("cargo::rerun-if-env-changed=DEP_FETCHLET_ENGINES");
    println!("cargo::rustc-check-cfg=cfg(fetchlet_engine)");
    if std::env::var("DEP_FETCHLET_ENGINES").is_ok_and(|engines| !engines.is_empty()) {
        println!("cargo::rustc-cfg=fetchlet_engine");
    }
}
