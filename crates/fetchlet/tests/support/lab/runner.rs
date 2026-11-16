#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
mod driver;

fn main() -> anyhow::Result<()> {
    #[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
    return driver::run();

    #[cfg(not(any(feature = "boa", feature = "quickjs", feature = "v8")))]
    anyhow::bail!("enable a JavaScript backend to run fetchlet-lab");
}
