// OPFS-backed workspace for a single in-flight download.
//
// Why: the v0.6 → v0.9 pipeline held every decrypted segment in memory
// before feeding mux.js. For a 14-min Hotmart lesson that's ~400 MB of
// JS heap; for a 2 GB lesson it's straight to OOM. The workspace stages
// each decrypted segment to a file under `/vdl-workspaces/<requestId>/`
// in the Origin Private File System, then streams them back into the
// remuxer one at a time.
//
// OPFS is per-origin and unique to the offscreen document. No
// chrome.storage involvement; quota is the browser's per-origin OPFS
// budget (Chrome's default is ~80% of disk free space).

const ROOT_DIR = 'vdl-workspaces';

export class OpfsWorkspace {
  private readonly dir: FileSystemDirectoryHandle;
  private closed = false;

  private constructor(dir: FileSystemDirectoryHandle) {
    this.dir = dir;
  }

  /**
   * Open (or create) the workspace directory for this requestId. The
   * directory is empty on open — if a workspace existed from a prior
   * crashed download with the same requestId (vanishingly rare since
   * requestId is a UUID), we clear it first.
   */
  static async open(requestId: string): Promise<OpfsWorkspace> {
    if (!('storage' in navigator) || !navigator.storage?.getDirectory) {
      throw new Error('OPFS unavailable in this context (navigator.storage.getDirectory missing)');
    }
    const root = await navigator.storage.getDirectory();
    const wsRoot = await root.getDirectoryHandle(ROOT_DIR, { create: true });
    // Drop any prior contents for this requestId before reopening.
    try {
      await wsRoot.removeEntry(requestId, { recursive: true });
    } catch {
      // not found — fine, fresh workspace.
    }
    const dir = await wsRoot.getDirectoryHandle(requestId, { create: true });
    return new OpfsWorkspace(dir);
  }

  /**
   * Write a decrypted segment to disk. Caller picks the index; we name
   * files `seg-<padded-index>.ts` so directory iteration is in playlist
   * order (not that we iterate — readSegment uses explicit indexing).
   */
  async writeSegment(index: number, bytes: Uint8Array): Promise<void> {
    this.assertOpen();
    const fh = await this.dir.getFileHandle(this.segmentName(index), { create: true });
    const writable = await fh.createWritable();
    try {
      // Cast to ArrayBuffer view: writable.write accepts BufferSource,
      // and TS 6.0's stricter Uint8Array<ArrayBufferLike> typing trips
      // on the union without the explicit narrowing.
      await writable.write(bytes as Uint8Array<ArrayBuffer>);
    } finally {
      await writable.close();
    }
  }

  /**
   * Read a previously-written segment back. The caller knows the
   * playlist order; we just dereference the index.
   */
  async readSegment(index: number): Promise<Uint8Array> {
    this.assertOpen();
    const fh = await this.dir.getFileHandle(this.segmentName(index));
    const file = await fh.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  /**
   * Create (truncating any prior file) an output file in this workspace.
   * Returns the handle. Caller uses `openOutputWritable` to stream bytes
   * in, then `getOutputFile` to read it back as a Blob-compatible File.
   */
  async createOutputFile(name: string): Promise<FileSystemFileHandle> {
    this.assertOpen();
    // Remove first so we always start from zero bytes. `create: true`
    // alone doesn't truncate an existing file.
    try {
      await this.dir.removeEntry(name);
    } catch {
      // not present — fine.
    }
    return this.dir.getFileHandle(name, { create: true });
  }

  /**
   * Open a writable stream for an output file. `keepExisting` controls
   * whether prior contents survive (needed for the patch-back pass, which
   * does positioned writes into specific moof byte ranges).
   */
  async openOutputWritable(
    name: string,
    opts: { keepExisting?: boolean } = {},
  ): Promise<FileSystemWritableFileStream> {
    this.assertOpen();
    const fh = await this.dir.getFileHandle(name);
    return fh.createWritable({ keepExistingData: opts.keepExisting ?? false });
  }

  /**
   * Read a previously-written output file back as a `File`. Browsers
   * back `URL.createObjectURL(file)` with the file source directly, so
   * chrome.downloads.download can stream from OPFS without copying the
   * full payload into JS heap.
   */
  async getOutputFile(name: string): Promise<File> {
    this.assertOpen();
    const fh = await this.dir.getFileHandle(name);
    return fh.getFile();
  }

  /**
   * Best-effort delete the workspace directory + all files. Called on
   * download completion, error, and cancel. Idempotent.
   */
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      const root = await navigator.storage.getDirectory();
      const wsRoot = await root.getDirectoryHandle(ROOT_DIR);
      await wsRoot.removeEntry(this.dir.name, { recursive: true });
    } catch {
      // Workspace already gone, or OPFS unavailable on this teardown.
      // Either way nothing to clean up.
    }
  }

  /**
   * Remove every workspace that wasn't disposed cleanly — e.g. the
   * extension reloaded or the offscreen crashed mid-download. Called
   * once at offscreen startup; cheap when the directory is empty.
   */
  static async cleanupAllStale(): Promise<void> {
    try {
      const root = await navigator.storage.getDirectory();
      // If the workspaces root doesn't exist, nothing to clean.
      let wsRoot: FileSystemDirectoryHandle;
      try {
        wsRoot = await root.getDirectoryHandle(ROOT_DIR);
      } catch {
        return;
      }
      // FileSystemDirectoryHandle is async-iterable in Chrome via the
      // values() iterator. Each entry is a file or directory handle.
      for await (const entry of wsRoot as unknown as AsyncIterable<FileSystemHandle>) {
        try {
          await wsRoot.removeEntry(entry.name, { recursive: true });
        } catch {
          // Best-effort.
        }
      }
    } catch {
      // OPFS unavailable.
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('OpfsWorkspace: used after dispose');
  }

  private segmentName(index: number): string {
    // Pad to 6 digits — fits ~277 hours at 6 second segments, comfortably
    // beyond anything we'd download.
    return `seg-${String(index).padStart(6, '0')}.ts`;
  }
}
