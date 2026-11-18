use std::io::Read;

use bytes::Bytes;
use http::{HeaderName, HeaderValue, StatusCode};

const MAGIC: &[u8; 4] = b"FLPK";
const VERSION: u16 = 1;
const HEADER_SIZE: usize = 80;
const ENTRY_SIZE: usize = 64;
const SET_SIZE: usize = 8;
const PAIR_SIZE: usize = 16;
const FLAG_BROTLI: u16 = 1;
const FLAG_KEEP_QUERY: u16 = 2;

/// A failure to read an asset archive.
#[derive(Debug, thiserror::Error)]
pub enum AssetArchiveError {
    #[error("not an asset archive")]
    Magic,
    #[error("unsupported asset archive version {0}")]
    Version(u16),
    #[error("invalid asset archive: {0}")]
    Invalid(&'static str),
    #[error("could not read {path}: {source}")]
    Read {
        path: std::path::PathBuf,
        source: std::io::Error,
    },
}

/// Client assets packed by `writeAssetArchive` in `fetchlet/build`.
///
/// The archive is checked once in [`AssetArchive::new`]; lookups and reads
/// then index into the same bytes. Embed it with
/// `AssetArchive::new(Bytes::from_static(include_bytes!(...)))` or read a
/// sidecar file with [`AssetArchive::open`].
#[derive(Clone, Debug)]
pub struct AssetArchive {
    bytes: Bytes,
    entries: Vec<Entry>,
    header_sets: Vec<Vec<(HeaderName, HeaderValue)>>,
}

#[derive(Clone, Debug)]
struct Entry {
    path: std::ops::Range<usize>,
    data: std::ops::Range<usize>,
    raw_size: u64,
    header_set: usize,
    status: StatusCode,
    brotli: bool,
    keep_query: bool,
    hash: [u8; 16],
}

/// One served path of an [`AssetArchive`].
#[derive(Clone, Copy, Debug)]
pub struct Asset<'a> {
    archive: &'a AssetArchive,
    entry: &'a Entry,
}

impl AssetArchive {
    /// Check `bytes` and index its entries.
    pub fn new(bytes: impl Into<Bytes>) -> Result<Self, AssetArchiveError> {
        let bytes = bytes.into();
        let invalid = AssetArchiveError::Invalid;
        let header = bytes
            .get(..HEADER_SIZE)
            .ok_or(invalid("truncated header"))?;
        if &header[..4] != MAGIC {
            return Err(AssetArchiveError::Magic);
        }
        let version = u16_at(header, 4);
        if version != VERSION {
            return Err(AssetArchiveError::Version(version));
        }
        if u16_at(header, 6) != 0 || u32_at(header, 20) != 0 {
            return Err(invalid("unknown header flags"));
        }
        let entry_count = u32_at(header, 8) as usize;
        let set_count = u32_at(header, 12) as usize;
        let pair_count = u32_at(header, 16) as usize;
        let table = |offset: usize, count: usize, size: usize, what: &'static str| {
            let start = u64_at(header, offset);
            let length = (count as u64)
                .checked_mul(size as u64)
                .ok_or(invalid(what))?;
            section(&bytes, start, length).ok_or(invalid(what))
        };
        let entry_table = table(24, entry_count, ENTRY_SIZE, "entry table out of bounds")?;
        let set_table = table(32, set_count, SET_SIZE, "header set table out of bounds")?;
        let pair_table = table(40, pair_count, PAIR_SIZE, "header pair table out of bounds")?;
        let strings = section(&bytes, u64_at(header, 48), u64_at(header, 56))
            .ok_or(invalid("string table out of bounds"))?;
        let data = section(&bytes, u64_at(header, 64), u64_at(header, 72))
            .ok_or(invalid("data out of bounds"))?;

        let string = |offset: u32, length: u32| -> Option<std::ops::Range<usize>> {
            let start = strings.start.checked_add(offset as usize)?;
            let end = start.checked_add(length as usize)?;
            (end <= strings.end).then_some(start..end)
        };

        let mut pairs = Vec::with_capacity(pair_count);
        for index in 0..pair_count {
            let record = &bytes[pair_table.start + index * PAIR_SIZE..][..PAIR_SIZE];
            let name = string(u32_at(record, 0), u32_at(record, 4))
                .ok_or(invalid("header name out of bounds"))?;
            let value = string(u32_at(record, 8), u32_at(record, 12))
                .ok_or(invalid("header value out of bounds"))?;
            let name = HeaderName::from_bytes(&bytes[name.clone()])
                .ok()
                .filter(|parsed| parsed.as_str().as_bytes() == &bytes[name])
                .ok_or(invalid("header name is not a lowercase token"))?;
            if is_derived(&name) {
                return Err(invalid("header set names a header the server derives"));
            }
            let value = HeaderValue::from_maybe_shared(bytes.slice(value))
                .map_err(|_| invalid("invalid header value"))?;
            pairs.push((name, value));
        }

        let mut header_sets = Vec::with_capacity(set_count);
        for index in 0..set_count {
            let record = &bytes[set_table.start + index * SET_SIZE..][..SET_SIZE];
            let first = u32_at(record, 0) as usize;
            let count = u32_at(record, 4) as usize;
            let set = first
                .checked_add(count)
                .and_then(|end| pairs.get(first..end))
                .ok_or(invalid("header set out of bounds"))?;
            header_sets.push(set.to_vec());
        }

        let mut entries: Vec<Entry> = Vec::with_capacity(entry_count);
        for index in 0..entry_count {
            let record = &bytes[entry_table.start + index * ENTRY_SIZE..][..ENTRY_SIZE];
            let path = string(u32_at(record, 0), u32_at(record, 4))
                .ok_or(invalid("path out of bounds"))?;
            let path_bytes = &bytes[path.clone()];
            if std::str::from_utf8(path_bytes).is_err() || !path_bytes.starts_with(b"/") {
                return Err(invalid("path is not an absolute UTF-8 path"));
            }
            if let Some(previous) = entries.last()
                && &bytes[previous.path.clone()] >= path_bytes
            {
                return Err(invalid("paths are not sorted and unique"));
            }
            let stored = u64_at(record, 16);
            let start = data.start as u64 + u64_at(record, 8);
            let data_range = section(&bytes, start, stored)
                .filter(|range| range.end <= data.end)
                .ok_or(invalid("entry data out of bounds"))?;
            let raw_size = u64_at(record, 24);
            let header_set = u32_at(record, 32) as usize;
            if header_set >= header_sets.len() {
                return Err(invalid("entry names a missing header set"));
            }
            let status = StatusCode::from_u16(u16_at(record, 36))
                .ok()
                .filter(|status| !status.is_informational())
                .ok_or(invalid("invalid status code"))?;
            let flags = u16_at(record, 38);
            if flags & !(FLAG_BROTLI | FLAG_KEEP_QUERY) != 0 {
                return Err(invalid("unknown entry flags"));
            }
            let brotli = flags & FLAG_BROTLI != 0;
            if !brotli && raw_size != stored {
                return Err(invalid("identity entry sizes differ"));
            }
            let mut hash = [0; 16];
            hash.copy_from_slice(&record[40..56]);
            entries.push(Entry {
                path,
                data: data_range,
                raw_size,
                header_set,
                status,
                brotli,
                keep_query: flags & FLAG_KEEP_QUERY != 0,
                hash,
            });
        }

        Ok(Self {
            bytes,
            entries,
            header_sets,
        })
    }

    /// Read and check an archive file, such as a sidecar next to the binary.
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self, AssetArchiveError> {
        let path = path.as_ref();
        let bytes = std::fs::read(path).map_err(|source| AssetArchiveError::Read {
            path: path.to_owned(),
            source,
        })?;
        Self::new(bytes)
    }

    /// The asset at a decoded URL path, such as `/assets/app.js`.
    pub fn get(&self, path: &str) -> Option<Asset<'_>> {
        self.entries
            .binary_search_by(|entry| self.bytes[entry.path.clone()].cmp(path.as_bytes()))
            .ok()
            .map(|index| Asset {
                archive: self,
                entry: &self.entries[index],
            })
    }

    /// The number of served paths.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl<'a> Asset<'a> {
    pub fn status(&self) -> StatusCode {
        self.entry.status
    }

    /// The stored response headers, without the ones the server derives.
    pub fn headers(&self) -> impl Iterator<Item = &'a (HeaderName, HeaderValue)> {
        self.archive.header_sets[self.entry.header_set].iter()
    }

    /// Whether the stored bytes are Brotli-compressed.
    pub fn is_brotli(&self) -> bool {
        self.entry.brotli
    }

    /// Whether a redirect appends the request's query to its `Location`.
    pub fn keeps_query(&self) -> bool {
        self.entry.keep_query
    }

    /// The size of the asset after decompression.
    pub fn raw_size(&self) -> u64 {
        self.entry.raw_size
    }

    /// The first 16 bytes of the SHA-256 of the decompressed asset.
    pub fn hash(&self) -> &'a [u8; 16] {
        &self.entry.hash
    }

    /// The bytes as stored, compressed for Brotli entries.
    pub fn stored(&self) -> Bytes {
        self.archive.bytes.slice(self.entry.data.clone())
    }

    /// The decompressed bytes. Fails when the stored stream is corrupt or
    /// does not decode to the recorded size.
    pub fn decompressed(&self) -> std::io::Result<Bytes> {
        let stored = self.stored();
        if !self.entry.brotli {
            return Ok(stored);
        }
        // The recorded size bounds the output; reserve at most 1 MiB up
        // front so a corrupt size cannot allocate before decoding fails.
        let capacity = usize::try_from(self.entry.raw_size.min(1 << 20)).unwrap_or(0);
        let mut raw = Vec::with_capacity(capacity);
        // Read one byte past the recorded size to detect a longer stream.
        brotli_decompressor::Decompressor::new(&stored[..], 4096)
            .take(self.entry.raw_size + 1)
            .read_to_end(&mut raw)?;
        if raw.len() as u64 != self.entry.raw_size {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "asset does not decode to its recorded size",
            ));
        }
        Ok(Bytes::from(raw))
    }
}

/// Headers the server sets from the representation it sends.
pub(super) fn is_derived(name: &HeaderName) -> bool {
    use http::header::*;
    [
        ACCEPT_RANGES,
        CONTENT_ENCODING,
        CONTENT_LENGTH,
        CONTENT_RANGE,
        ETAG,
        TRANSFER_ENCODING,
    ]
    .contains(name)
}

/// A byte range of `bytes`, when it lies inside.
fn section(bytes: &[u8], start: u64, length: u64) -> Option<std::ops::Range<usize>> {
    let start = usize::try_from(start).ok()?;
    let end = start.checked_add(usize::try_from(length).ok()?)?;
    (end <= bytes.len()).then_some(start..end)
}

fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap())
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn u64_at(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One entry of an archive the tests write field by field.
    struct EntrySpec {
        path: &'static str,
        data: Vec<u8>,
        raw_size: u64,
        set: u32,
        status: u16,
        flags: u16,
    }

    fn entry(path: &'static str, data: &[u8]) -> EntrySpec {
        EntrySpec {
            path,
            data: data.to_vec(),
            raw_size: data.len() as u64,
            set: 0,
            status: 200,
            flags: 0,
        }
    }

    /// An archive in the layout `writeAssetArchive` produces: header, entry,
    /// header set and pair tables, strings, then data.
    struct Spec {
        entries: Vec<EntrySpec>,
        sets: Vec<(u32, u32)>,
        pairs: Vec<(&'static str, &'static str)>,
    }

    impl Spec {
        fn new() -> Self {
            Self {
                entries: vec![entry("/a.txt", b"alpha"), entry("/b.txt", b"beta")],
                sets: vec![(0, 1)],
                pairs: vec![("content-type", "text/plain")],
            }
        }

        fn write(&self) -> Vec<u8> {
            let mut strings = Vec::new();
            let mut string = |text: &str| {
                let offset = strings.len() as u32;
                strings.extend_from_slice(text.as_bytes());
                (offset, text.len() as u32)
            };
            let mut data = Vec::new();
            let mut entry_table = Vec::new();
            for entry in &self.entries {
                let (offset, length) = string(entry.path);
                entry_table.extend_from_slice(&offset.to_le_bytes());
                entry_table.extend_from_slice(&length.to_le_bytes());
                entry_table.extend_from_slice(&(data.len() as u64).to_le_bytes());
                entry_table.extend_from_slice(&(entry.data.len() as u64).to_le_bytes());
                entry_table.extend_from_slice(&entry.raw_size.to_le_bytes());
                entry_table.extend_from_slice(&entry.set.to_le_bytes());
                entry_table.extend_from_slice(&entry.status.to_le_bytes());
                entry_table.extend_from_slice(&entry.flags.to_le_bytes());
                entry_table.extend_from_slice(&[7; 16]);
                entry_table.extend_from_slice(&[0; 8]);
                data.extend_from_slice(&entry.data);
            }
            let mut set_table = Vec::new();
            for (first, count) in &self.sets {
                set_table.extend_from_slice(&first.to_le_bytes());
                set_table.extend_from_slice(&count.to_le_bytes());
            }
            let mut pair_table = Vec::new();
            for (name, value) in &self.pairs {
                for (offset, length) in [string(name), string(value)] {
                    pair_table.extend_from_slice(&offset.to_le_bytes());
                    pair_table.extend_from_slice(&length.to_le_bytes());
                }
            }

            let mut bytes = vec![0; HEADER_SIZE];
            bytes[..4].copy_from_slice(MAGIC);
            bytes[4..6].copy_from_slice(&VERSION.to_le_bytes());
            let counts = [self.entries.len(), self.sets.len(), self.pairs.len()];
            for (index, count) in counts.into_iter().enumerate() {
                bytes[8 + index * 4..][..4].copy_from_slice(&(count as u32).to_le_bytes());
            }
            for (offset, table) in [(24, &entry_table), (32, &set_table), (40, &pair_table)] {
                let start = bytes.len() as u64;
                put_u64(&mut bytes, offset, start);
                bytes.extend_from_slice(table);
            }
            for (offset, section) in [(48, &strings), (64, &data)] {
                let start = bytes.len() as u64;
                put_u64(&mut bytes, offset, start);
                put_u64(&mut bytes, offset + 8, section.len() as u64);
                bytes.extend_from_slice(section);
            }
            bytes
        }
    }

    fn reason(bytes: Vec<u8>) -> &'static str {
        match AssetArchive::new(bytes) {
            Err(AssetArchiveError::Invalid(reason)) => reason,
            other => panic!("expected an invalid archive, got {other:?}"),
        }
    }

    fn put_u64(bytes: &mut [u8], offset: usize, value: u64) {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }

    #[test]
    fn a_written_archive_reads_back() {
        let archive = AssetArchive::new(Spec::new().write()).unwrap();
        assert_eq!(archive.len(), 2);
        assert!(!archive.is_empty());
        let asset = archive.get("/b.txt").unwrap();
        assert_eq!(asset.status(), StatusCode::OK);
        assert_eq!(asset.stored(), "beta");
        assert_eq!(asset.decompressed().unwrap(), "beta");
        assert_eq!(asset.raw_size(), 4);
        assert_eq!(asset.hash(), &[7; 16]);
        assert!(!asset.is_brotli() && !asset.keeps_query());
        let headers: Vec<_> = asset.headers().collect();
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0].0, http::header::CONTENT_TYPE);
        assert!(archive.get("/c.txt").is_none());
        assert!(archive.get("a.txt").is_none());
    }

    #[test]
    fn an_empty_archive_has_no_entries() {
        let spec = Spec {
            entries: vec![],
            sets: vec![],
            pairs: vec![],
        };
        let archive = AssetArchive::new(spec.write()).unwrap();
        assert!(archive.is_empty());
        assert!(archive.get("/").is_none());
    }

    #[test]
    fn redirects_keep_their_status_and_query_flag() {
        let mut spec = Spec::new();
        spec.pairs.push(("location", "/b.txt"));
        spec.sets.push((1, 1));
        spec.entries[0].data.clear();
        spec.entries[0].raw_size = 0;
        spec.entries[0].set = 1;
        spec.entries[0].status = 308;
        spec.entries[0].flags = FLAG_KEEP_QUERY;
        let archive = AssetArchive::new(spec.write()).unwrap();
        let redirect = archive.get("/a.txt").unwrap();
        assert_eq!(redirect.status(), StatusCode::PERMANENT_REDIRECT);
        assert!(redirect.keeps_query());
        assert_eq!(redirect.headers().next().unwrap().1, "/b.txt");
    }

    #[test]
    fn the_header_must_match_this_version() {
        let mut bytes = Spec::new().write();
        bytes[6] = 1;
        assert_eq!(reason(bytes), "unknown header flags");
        let mut bytes = Spec::new().write();
        bytes[20] = 1;
        assert_eq!(reason(bytes), "unknown header flags");
        assert_eq!(reason(vec![0; HEADER_SIZE - 1]), "truncated header");
    }

    #[test]
    fn tables_outside_the_archive_are_refused() {
        for (offset, expected) in [
            (24, "entry table out of bounds"),
            (32, "header set table out of bounds"),
            (40, "header pair table out of bounds"),
            (48, "string table out of bounds"),
            (64, "data out of bounds"),
            (72, "data out of bounds"),
        ] {
            let mut bytes = Spec::new().write();
            put_u64(&mut bytes, offset, u64::MAX);
            assert_eq!(reason(bytes), expected, "offset {offset}");
        }
        // A count whose table size overflows is refused, not wrapped.
        let mut bytes = Spec::new().write();
        bytes[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(reason(bytes), "entry table out of bounds");
    }

    #[test]
    fn header_pairs_must_be_lowercase_valid_and_not_derived() {
        for (name, value, expected) in [
            (
                "Content-Type",
                "text/plain",
                "header name is not a lowercase token",
            ),
            ("bad name", "x", "header name is not a lowercase token"),
            (
                "etag",
                "\"x\"",
                "header set names a header the server derives",
            ),
            (
                "content-length",
                "5",
                "header set names a header the server derives",
            ),
            ("x-value", "line\nbreak", "invalid header value"),
        ] {
            let mut spec = Spec::new();
            spec.pairs = vec![(name, value)];
            assert_eq!(reason(spec.write()), expected, "{name}");
        }
    }

    #[test]
    fn header_sets_must_lie_inside_the_pairs() {
        for set in [(0, 2), (1, 1), (u32::MAX, 2)] {
            let mut spec = Spec::new();
            spec.sets = vec![set];
            assert_eq!(reason(spec.write()), "header set out of bounds", "{set:?}");
        }
        let mut spec = Spec::new();
        spec.entries[1].set = 1;
        assert_eq!(reason(spec.write()), "entry names a missing header set");
    }

    #[test]
    fn paths_must_be_absolute_sorted_and_unique() {
        let mut spec = Spec::new();
        spec.entries[0].path = "a.txt";
        assert_eq!(reason(spec.write()), "path is not an absolute UTF-8 path");
        let mut spec = Spec::new();
        spec.entries.swap(0, 1);
        assert_eq!(reason(spec.write()), "paths are not sorted and unique");
        let mut spec = Spec::new();
        spec.entries[1].path = "/a.txt";
        assert_eq!(reason(spec.write()), "paths are not sorted and unique");
    }

    #[test]
    fn entries_must_have_valid_status_flags_and_sizes() {
        for status in [100, 99, 1000] {
            let mut spec = Spec::new();
            spec.entries[0].status = status;
            assert_eq!(reason(spec.write()), "invalid status code", "{status}");
        }
        let mut spec = Spec::new();
        spec.entries[0].flags = 4;
        assert_eq!(reason(spec.write()), "unknown entry flags");
        let mut spec = Spec::new();
        spec.entries[0].raw_size = 6;
        assert_eq!(reason(spec.write()), "identity entry sizes differ");
    }

    #[test]
    fn entry_data_must_lie_inside_the_data_section() {
        let mut bytes = Spec::new().write();
        // The second entry's stored size, in the entry table after the header.
        put_u64(&mut bytes, HEADER_SIZE + ENTRY_SIZE + 16, 100);
        assert_eq!(reason(bytes), "entry data out of bounds");
    }

    #[test]
    fn brotli_entries_must_decode_to_their_recorded_size() {
        let mut spec = Spec::new();
        // 0x06 is a complete Brotli stream: one empty last metablock.
        for (entry, raw_size) in spec.entries.iter_mut().zip([0, 3]) {
            entry.data = vec![0x06];
            entry.raw_size = raw_size;
            entry.flags = FLAG_BROTLI;
        }
        let archive = AssetArchive::new(spec.write()).unwrap();
        let empty = archive.get("/a.txt").unwrap();
        assert!(empty.is_brotli());
        assert_eq!(empty.decompressed().unwrap(), "");
        let short = archive.get("/b.txt").unwrap();
        assert_eq!(
            short.decompressed().unwrap_err().kind(),
            std::io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn the_server_derives_representation_headers() {
        use http::header::*;
        for name in [
            ETAG,
            CONTENT_LENGTH,
            CONTENT_ENCODING,
            CONTENT_RANGE,
            ACCEPT_RANGES,
            TRANSFER_ENCODING,
        ] {
            assert!(is_derived(&name), "{name}");
        }
        for name in [CONTENT_TYPE, CACHE_CONTROL, LOCATION, VARY] {
            assert!(!is_derived(&name), "{name}");
        }
    }

    #[test]
    fn sections_reject_overflowing_ranges() {
        let bytes = [0; 8];
        assert_eq!(section(&bytes, 2, 6), Some(2..8));
        assert_eq!(section(&bytes, 8, 0), Some(8..8));
        assert_eq!(section(&bytes, 2, 7), None);
        assert_eq!(section(&bytes, u64::MAX, 1), None);
        assert_eq!(section(&bytes, 1, u64::MAX), None);
    }

    #[test]
    fn opening_a_missing_file_names_it() {
        let path = std::env::temp_dir().join("fetchlet-missing-archive.flpk");
        match AssetArchive::open(&path) {
            Err(AssetArchiveError::Read { path: named, .. }) => assert_eq!(named, path),
            other => panic!("expected a read error, got {other:?}"),
        }
    }
}
