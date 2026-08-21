//! Minimal read-only reader for Cursor's `store.db`.

use anyhow::{Context, Result};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use std::path::Path;

/// Reads every row of `SELECT data FROM blobs` from a Cursor `store.db`.
///
/// Opened read-only and immutable so a running Cursor is never disturbed and
/// its `-wal` / `-shm` files are left untouched — immutable also means
/// uncheckpointed WAL frames are invisible, which is v1's view of the data. A
/// db that will not open (or has no `blobs` table) returns `Err`, and the scan
/// counts it as a failed file.
///
/// Rows come back as blob, text, or null. Null and numeric rows are dropped
/// here rather than surfaced: the only caller skips them anyway, since they can
/// never start with the `{` that marks a JSON blob.
pub fn read_blobs(path: &Path) -> Result<Vec<Vec<u8>>> {
    // `immutable=1` is load-bearing, and it only reaches SQLite through a URI,
    // hence `SQLITE_OPEN_URI`.
    let uri = format!("file:{}?mode=ro&immutable=1", path.display());
    let conn = Connection::open_with_flags(
        &uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .with_context(|| format!("opening {}", path.display()))?;

    let mut stmt = conn.prepare("SELECT data FROM blobs")?;
    let rows = stmt.query_map([], |row| {
        Ok(match row.get_ref(0)? {
            ValueRef::Blob(b) => Some(b.to_vec()),
            ValueRef::Text(t) => Some(t.to_vec()),
            _ => None,
        })
    })?;

    // `Result<Option<T>>` transposed is `Option<Result<T>>`, so the rows that
    // held neither a blob nor text drop out and the first real error still
    // stops the scan.
    Ok(rows
        .filter_map(Result::transpose)
        .collect::<rusqlite::Result<Vec<_>>>()?)
}
