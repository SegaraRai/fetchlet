//! Runs a bundle on one engine and answers stdin lines: `vp run build:lab`.
//! tools/workspace/lab.ts speaks its protocol.

mod driver;
mod mock_transport;

fn main() -> anyhow::Result<()> {
    driver::run()
}
