#![no_main]

// Arbitrary bytes as an asset archive: AssetArchive::new refuses or indexes
// them, and every indexed asset reads without panicking.

use libfuzzer_sys::fuzz_target;

use fetchlet_http::AssetArchive;

fuzz_target!(|data: &[u8]| {
    let Ok(archive) = AssetArchive::new(data.to_vec()) else {
        return;
    };
    // Lookups by the first bytes as a path, and a scan of the usual paths.
    let probe = String::from_utf8_lossy(&data[..data.len().min(32)]).into_owned();
    for path in [probe.as_str(), "/", "/index.html", "/a"] {
        if let Some(asset) = archive.get(path) {
            let _ = asset.headers().count();
            let _ = asset.stored();
            if let Ok(raw) = asset.decompressed() {
                assert_eq!(raw.len() as u64, asset.raw_size());
            }
        }
    }
});
