#[cfg(any(feature = "quickjs", feature = "boa", feature = "v8"))]
mod driver;

fn main() -> anyhow::Result<()> {
    #[cfg(any(feature = "quickjs", feature = "boa", feature = "v8"))]
    return driver::run();

    #[cfg(not(any(feature = "quickjs", feature = "boa", feature = "v8")))]
    anyhow::bail!("enable a JavaScript backend to run fetchlet-lab");
}
