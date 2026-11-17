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
