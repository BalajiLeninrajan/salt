export interface BlobRow {
  data: Uint8Array | string | null;
}

/**
 * Reads every row of `SELECT data FROM blobs` from a Cursor `store.db`.
 *
 * Opened read-only and immutable so a running Cursor is never disturbed and
 * its `-wal` / `-shm` files are left untouched — immutable also means
 * uncheckpointed WAL frames are invisible, which is v1's view of the data. A
 * db that will not open throws, and the scan counts it as a failed file.
 */
export async function readBlobs(path: string): Promise<(Uint8Array | string | null)[]> {
  const { Database } = await import("bun:sqlite");

  const db = new Database(`file:${path}?mode=ro&immutable=1`, { readonly: true });
  try {
    return db
      .query("SELECT data FROM blobs")
      .all()
      .map((row) => (row as BlobRow).data);
  } finally {
    db.close();
  }
}
