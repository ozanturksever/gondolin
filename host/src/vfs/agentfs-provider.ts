import type { Stats as NodeStats, Dirent } from "node:fs";
import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";

import type { VirtualProvider, VirtualFileHandle } from "./node";
import { VirtualProviderClass, ERRNO, normalizeVfsPath, isWriteFlag } from "./utils";
import { createErrnoError } from "./errors";

// ---------------------------------------------------------------------------
// Interfaces matching the AgentFS TypeScript SDK
// Defined locally to avoid CJS/ESM import issues with agentfs-sdk.
// Accept any object conforming to these interfaces in the constructor.
// ---------------------------------------------------------------------------

export interface AgentFSStatsLike {
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  size: number;
  /** Unix timestamp in seconds */
  atime: number;
  /** Unix timestamp in seconds */
  mtime: number;
  /** Unix timestamp in seconds */
  ctime: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface AgentFSFileHandleLike {
  pread(offset: number, size: number): Promise<Buffer>;
  pwrite(offset: number, data: Buffer): Promise<void>;
  truncate(size: number): Promise<void>;
  fsync(): Promise<void>;
  fstat(): Promise<AgentFSStatsLike>;
}

export interface AgentFSDirEntryLike {
  name: string;
  stats: AgentFSStatsLike;
}

/**
 * Interface matching the AgentFS TypeScript SDK's FileSystem.
 *
 * Any object implementing this interface can be used with AgentFSProvider.
 * Typically this is an AgentFS instance from `agentfs-sdk`.
 */
export interface AgentFSLike {
  stat(path: string): Promise<AgentFSStatsLike>;
  lstat(path: string): Promise<AgentFSStatsLike>;
  readFile(path: string): Promise<Buffer>;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  readFile(path: string, options: { encoding: BufferEncoding }): Promise<string>;
  readFile(path: string, options?: BufferEncoding | { encoding?: BufferEncoding }): Promise<Buffer | string>;
  writeFile(
    path: string,
    data: string | Buffer,
    options?: BufferEncoding | { encoding?: BufferEncoding },
  ): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdirPlus?(path: string): Promise<AgentFSDirEntryLike[]>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  copyFile?(src: string, dest: string): Promise<void>;
  symlink?(target: string, linkpath: string): Promise<void>;
  readlink?(path: string): Promise<string>;
  access(path: string): Promise<void>;
  open(path: string): Promise<AgentFSFileHandleLike>;
  rm?(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Change hooks — fired after mutations (used by ConvexFileSync in Phase 4)
// ---------------------------------------------------------------------------

export interface AgentFSChangeHooks {
  onWrite?(path: string): void | Promise<void>;
  onDelete?(path: string): void | Promise<void>;
  onRename?(oldPath: string, newPath: string): void | Promise<void>;
  onMkdir?(path: string): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Workspace initialization
// ---------------------------------------------------------------------------

export interface WorkspaceInitOptions {
  workspaceId: string;
  /** Override the database file path (default: ~/.gondolin/workspaces/{id}/workspace.db) */
  dbPath?: string;
  /** Initial files to populate (key = path, value = content) */
  files?: Record<string, string | Buffer>;
  /** Change hooks for sync integration */
  hooks?: AgentFSChangeHooks;
  /** Base filesystem for COW overlay mode. When provided, all writes go to an in-memory overlay and the base is never mutated. */
  baseFS?: AgentFSLike;
}

/**
 * Initialize a workspace backed by AgentFS.
 *
 * @param openFS Factory that opens an AgentFS instance given a database path.
 *               Typically: `(dbPath) => AgentFS.open({ path: dbPath })`
 * @param options Workspace configuration
 */
export async function initializeWorkspace(
  openFS: (dbPath: string) => Promise<AgentFSLike>,
  options: WorkspaceInitOptions,
): Promise<AgentFSProvider> {
  const wsDir = options.dbPath
    ? nodePath.dirname(options.dbPath)
    : nodePath.join(os.homedir(), ".gondolin", "workspaces", options.workspaceId);

  nodeFs.mkdirSync(wsDir, { recursive: true });

  let agentfs: AgentFSLike;

  if (options.baseFS) {
    // COW overlay mode: wrap base FS so it is never mutated
    const { CowOverlayFS } = await import("./cow-overlay");
    agentfs = new CowOverlayFS(options.baseFS);
  } else {
    const dbPath = options.dbPath ?? nodePath.join(wsDir, "workspace.db");
    agentfs = await openFS(dbPath);
  }

  if (options.files) {
    for (const [filePath, content] of Object.entries(options.files)) {
      await agentfs.writeFile(filePath, content);
    }
  }

  return new AgentFSProvider(agentfs, options.hooks);
}

// ---------------------------------------------------------------------------
// Stats conversion helpers
// ---------------------------------------------------------------------------

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

function toNodeStats(src: AgentFSStatsLike): NodeStats {
  const atimeMs = src.atime * 1000;
  const mtimeMs = src.mtime * 1000;
  const ctimeMs = src.ctime * 1000;
  const stats = Object.create(nodeFs.Stats.prototype) as NodeStats;
  Object.assign(stats, {
    dev: 0,
    mode: src.mode,
    nlink: src.nlink,
    uid: src.uid,
    gid: src.gid,
    rdev: 0,
    blksize: 4096,
    ino: src.ino,
    size: src.size,
    blocks: Math.ceil(src.size / 512) || 0,
    atimeMs,
    mtimeMs,
    ctimeMs,
    birthtimeMs: ctimeMs,
    atime: new Date(atimeMs),
    mtime: new Date(mtimeMs),
    ctime: new Date(ctimeMs),
    birthtime: new Date(ctimeMs),
  });
  return stats;
}

// ---------------------------------------------------------------------------
// Dirent adapter for readdir({ withFileTypes: true })
// ---------------------------------------------------------------------------

class AgentFSDirent {
  constructor(
    public readonly name: string,
    private readonly mode: number,
  ) {}

  isFile() {
    return (this.mode & S_IFMT) === S_IFREG;
  }

  isDirectory() {
    return (this.mode & S_IFMT) === S_IFDIR;
  }

  isSymbolicLink() {
    return (this.mode & S_IFMT) === S_IFLNK;
  }

  isBlockDevice() {
    return false;
  }

  isCharacterDevice() {
    return false;
  }

  isFIFO() {
    return false;
  }

  isSocket() {
    return false;
  }
}

// ---------------------------------------------------------------------------
// File handle adapter: AgentFS FileHandle → Gondolin VirtualFileHandle
// ---------------------------------------------------------------------------

class AgentFSFileHandleAdapter implements VirtualFileHandle {
  private _position: number;
  private _closed = false;

  constructor(
    private readonly inner: AgentFSFileHandleLike,
    readonly path: string,
    readonly flags: string,
    readonly mode: number,
    startPosition: number,
  ) {
    this._position = startPosition;
  }

  get position() {
    return this._position;
  }

  get closed() {
    return this._closed;
  }

  async read(
    buffer: Buffer,
    offset: number,
    length: number,
    position?: number | null,
  ): Promise<{ bytesRead: number; buffer: Buffer }> {
    this.ensureOpen();
    const readPos = position != null ? position : this._position;
    const data = await this.inner.pread(readPos, length);
    const bytesRead = data.length;
    data.copy(buffer, offset, 0, bytesRead);
    if (position == null) {
      this._position += bytesRead;
    }
    return { bytesRead, buffer };
  }

  readSync(): never {
    throw new Error("AgentFSProvider does not support synchronous operations");
  }

  async write(
    buffer: Buffer,
    offset: number,
    length: number,
    position?: number | null,
  ): Promise<{ bytesWritten: number; buffer: Buffer }> {
    this.ensureOpen();
    const writePos = position != null ? position : this._position;
    const slice = buffer.subarray(offset, offset + length);
    await this.inner.pwrite(writePos, slice);
    if (position == null) {
      this._position += length;
    }
    return { bytesWritten: length, buffer };
  }

  writeSync(): never {
    throw new Error("AgentFSProvider does not support synchronous operations");
  }

  async readFile(
    options?: { encoding?: BufferEncoding } | BufferEncoding,
  ): Promise<Buffer | string> {
    this.ensureOpen();
    const stats = await this.inner.fstat();
    if (stats.size === 0) {
      const empty = Buffer.alloc(0);
      const encoding = typeof options === "string" ? options : options?.encoding;
      return encoding ? empty.toString(encoding) : empty;
    }
    const content = await this.inner.pread(0, stats.size);
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? content.toString(encoding) : content;
  }

  readFileSync(): never {
    throw new Error("AgentFSProvider does not support synchronous operations");
  }

  async writeFile(
    data: Buffer | string,
    options?: { encoding?: BufferEncoding },
  ): Promise<void> {
    this.ensureOpen();
    const buffer =
      typeof data === "string"
        ? Buffer.from(data, options?.encoding ?? "utf8")
        : data;
    await this.inner.truncate(0);
    if (buffer.length > 0) {
      await this.inner.pwrite(0, buffer);
    }
    this._position = buffer.length;
  }

  writeFileSync(): never {
    throw new Error("AgentFSProvider does not support synchronous operations");
  }

  async stat(): Promise<NodeStats> {
    this.ensureOpen();
    const agentStats = await this.inner.fstat();
    return toNodeStats(agentStats);
  }

  statSync(): never {
    throw new Error("AgentFSProvider does not support synchronous operations");
  }

  async truncate(len?: number): Promise<void> {
    this.ensureOpen();
    await this.inner.truncate(len ?? 0);
    if (this._position > (len ?? 0)) {
      this._position = len ?? 0;
    }
  }

  truncateSync(): never {
    throw new Error("AgentFSProvider does not support synchronous operations");
  }

  async close(): Promise<void> {
    this._closed = true;
  }

  closeSync(): void {
    this._closed = true;
  }

  private ensureOpen(): void {
    if (this._closed) {
      throw createErrnoError(-ERRNO.EBADF, "read", this.path);
    }
  }
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function mapFsError(err: unknown, syscall: string, fsPath?: string): NodeJS.ErrnoException {
  if (err && typeof err === "object") {
    const e = err as { code?: string; message?: string };
    switch (e.code) {
      case "ENOENT":
        return createErrnoError(-ERRNO.ENOENT, syscall, fsPath);
      case "EEXIST":
        return createErrnoError(-ERRNO.EEXIST, syscall, fsPath);
      case "EISDIR":
        return createErrnoError(-ERRNO.EISDIR, syscall, fsPath);
      case "ENOTDIR":
        return createErrnoError(-ERRNO.ENOTDIR, syscall, fsPath);
      case "ENOTEMPTY":
        return createErrnoError(-ERRNO.ENOTEMPTY, syscall, fsPath);
      case "EACCES":
        return createErrnoError(-ERRNO.EACCES, syscall, fsPath);
      case "EPERM":
        return createErrnoError(-ERRNO.EPERM, syscall, fsPath);
      case "EINVAL":
        return createErrnoError(-ERRNO.EINVAL, syscall, fsPath);
    }
  }
  if (err instanceof Error) {
    const wrapped = new Error(err.message) as NodeJS.ErrnoException;
    wrapped.syscall = syscall;
    if (fsPath) wrapped.path = fsPath;
    return wrapped;
  }
  return createErrnoError(-ERRNO.EIO, syscall, fsPath);
}

// ---------------------------------------------------------------------------
// AgentFSProvider — wraps AgentFS as a Gondolin VirtualProvider
// ---------------------------------------------------------------------------

export class AgentFSProvider extends VirtualProviderClass implements VirtualProvider {
  private changeHooks: AgentFSChangeHooks;

  get readonly() {
    return false;
  }

  get supportsSymlinks() {
    return true;
  }

  get supportsWatch() {
    return false;
  }

  constructor(
    private readonly agentfs: AgentFSLike,
    hooks?: AgentFSChangeHooks,
  ) {
    super();
    this.changeHooks = hooks ?? {};
  }

  /** Access the underlying AgentFS filesystem instance */
  getFilesystem(): AgentFSLike {
    return this.agentfs;
  }

  // ---- async operations ---------------------------------------------------

  async open(path: string, flags: string, mode?: number): Promise<VirtualFileHandle> {
    const normalized = normalizeVfsPath(path);
    const isCreate = flags.includes("w") || flags.includes("a");
    const isTruncate = flags.includes("w");
    const isAppend = flags.includes("a");
    const isExclusive = flags.includes("x");

    try {
      if (isCreate) {
        let exists = false;
        try {
          await this.agentfs.stat(normalized);
          exists = true;
        } catch {
          exists = false;
        }

        if (exists && isExclusive) {
          throw createErrnoError(-ERRNO.EEXIST, "open", normalized);
        }

        if (!exists) {
          await this.agentfs.writeFile(normalized, Buffer.alloc(0));
          this.fireHook(this.changeHooks.onWrite, normalized);
        } else if (isTruncate) {
          await this.agentfs.writeFile(normalized, Buffer.alloc(0));
          this.fireHook(this.changeHooks.onWrite, normalized);
        }
      }

      const handle = await this.agentfs.open(normalized);
      let startPosition = 0;
      if (isAppend) {
        const stats = await handle.fstat();
        startPosition = stats.size;
      }

      return new AgentFSFileHandleAdapter(
        handle,
        normalized,
        flags,
        mode ?? 0o644,
        startPosition,
      );
    } catch (err) {
      throw mapFsError(err, "open", normalized);
    }
  }

  openSync(): never {
    throw new Error("AgentFSProvider does not support synchronous operations");
  }

  async stat(path: string): Promise<NodeStats> {
    const normalized = normalizeVfsPath(path);
    try {
      const agentStats = await this.agentfs.stat(normalized);
      return toNodeStats(agentStats);
    } catch (err) {
      throw mapFsError(err, "stat", normalized);
    }
  }

  statSync(): never {
    throw new Error("AgentFSProvider does not support synchronous operations");
  }

  async lstat(path: string): Promise<NodeStats> {
    const normalized = normalizeVfsPath(path);
    try {
      const agentStats = await this.agentfs.lstat(normalized);
      return toNodeStats(agentStats);
    } catch (err) {
      throw mapFsError(err, "lstat", normalized);
    }
  }

  lstatSync(): never {
    throw new Error("AgentFSProvider does not support synchronous operations");
  }

  async readdir(path: string, options?: object): Promise<Array<string | Dirent>> {
    const normalized = normalizeVfsPath(path);
    const withFileTypes = !!(options as { withFileTypes?: boolean })?.withFileTypes;

    try {
      if (withFileTypes && this.agentfs.readdirPlus) {
        const entries = await this.agentfs.readdirPlus(normalized);
        return entries.map(
          (e) => new AgentFSDirent(e.name, e.stats.mode) as unknown as Dirent,
        );
      }

      const names = await this.agentfs.readdir(normalized);

      if (withFileTypes) {
        const dirents: Dirent[] = [];
        for (const name of names) {
          const childPath = normalized === "/" ? `/${name}` : `${normalized}/${name}`;
          try {
            const childStats = await this.agentfs.stat(childPath);
            dirents.push(
              new AgentFSDirent(name, childStats.mode) as unknown as Dirent,
            );
          } catch {
            dirents.push(new AgentFSDirent(name, S_IFREG | 0o644) as unknown as Dirent);
          }
        }
        return dirents;
      }

      return names;
    } catch (err) {
      throw mapFsError(err, "readdir", normalized);
    }
  }

  readdirSync(): never {
    throw new Error("AgentFSProvider does not support synchronous operations");
  }

  async mkdir(path: string, options?: object): Promise<void | string> {
    const normalized = normalizeVfsPath(path);
    const recursive = !!(options as { recursive?: boolean })?.recursive;

    try {
      if (recursive) {
        const parts = normalized.split("/").filter(Boolean);
        let current = "";
        for (const part of parts) {
          current += "/" + part;
          try {
            await this.agentfs.mkdir(current);
            this.fireHook(this.changeHooks.onMkdir, current);
          } catch (err) {
            const e = err as { code?: string };
            if (e.code !== "EEXIST") throw err;
          }
        }
        return normalized;
      }

      await this.agentfs.mkdir(normalized);
      this.fireHook(this.changeHooks.onMkdir, normalized);
    } catch (err) {
      throw mapFsError(err, "mkdir", normalized);
    }
  }

  mkdirSync(): never {
    throw new Error("AgentFSProvider does not support synchronous operations");
  }

  async rmdir(path: string): Promise<void> {
    const normalized = normalizeVfsPath(path);
    try {
      await this.agentfs.rmdir(normalized);
      this.fireHook(this.changeHooks.onDelete, normalized);
    } catch (err) {
      throw mapFsError(err, "rmdir", normalized);
    }
  }

  rmdirSync(): never {
    throw new Error("AgentFSProvider does not support synchronous operations");
  }

  async unlink(path: string): Promise<void> {
    const normalized = normalizeVfsPath(path);
    try {
      await this.agentfs.unlink(normalized);
      this.fireHook(this.changeHooks.onDelete, normalized);
    } catch (err) {
      throw mapFsError(err, "unlink", normalized);
    }
  }

  unlinkSync(): never {
    throw new Error("AgentFSProvider does not support synchronous operations");
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const oldNormalized = normalizeVfsPath(oldPath);
    const newNormalized = normalizeVfsPath(newPath);
    try {
      await this.agentfs.rename(oldNormalized, newNormalized);
      this.fireHook(this.changeHooks.onRename, oldNormalized, newNormalized);
    } catch (err) {
      throw mapFsError(err, "rename", oldNormalized);
    }
  }

  renameSync(): never {
    throw new Error("AgentFSProvider does not support synchronous operations");
  }

  // ---- optional VirtualProvider methods ------------------------------------

  async readFile(
    path: string,
    options?: { encoding?: BufferEncoding } | BufferEncoding,
  ): Promise<Buffer | string> {
    const normalized = normalizeVfsPath(path);
    try {
      const encoding = typeof options === "string" ? options : options?.encoding;
      if (encoding) {
        return await this.agentfs.readFile(normalized, encoding);
      }
      return await this.agentfs.readFile(normalized);
    } catch (err) {
      throw mapFsError(err, "readFile", normalized);
    }
  }

  readFileSync(): never {
    throw new Error("AgentFSProvider does not support synchronous operations");
  }

  async writeFile(
    path: string,
    data: Buffer | string,
    options?: { encoding?: BufferEncoding; mode?: number },
  ): Promise<void> {
    const normalized = normalizeVfsPath(path);
    try {
      const encoding = options?.encoding;
      if (encoding) {
        await this.agentfs.writeFile(normalized, data, { encoding });
      } else {
        await this.agentfs.writeFile(normalized, data);
      }
      this.fireHook(this.changeHooks.onWrite, normalized);
    } catch (err) {
      throw mapFsError(err, "writeFile", normalized);
    }
  }

  writeFileSync(): never {
    throw new Error("AgentFSProvider does not support synchronous operations");
  }

  async access(path: string): Promise<void> {
    const normalized = normalizeVfsPath(path);
    try {
      await this.agentfs.access(normalized);
    } catch (err) {
      throw mapFsError(err, "access", normalized);
    }
  }

  accessSync(): never {
    throw new Error("AgentFSProvider does not support synchronous operations");
  }

  async readlink(path: string): Promise<string> {
    const normalized = normalizeVfsPath(path);
    if (!this.agentfs.readlink) {
      throw createErrnoError(-ERRNO.ENOSYS, "readlink", normalized);
    }
    try {
      return await this.agentfs.readlink(normalized);
    } catch (err) {
      throw mapFsError(err, "readlink", normalized);
    }
  }

  readlinkSync(): never {
    throw new Error("AgentFSProvider does not support synchronous operations");
  }

  async symlink(target: string, path: string): Promise<void> {
    const normalized = normalizeVfsPath(path);
    if (!this.agentfs.symlink) {
      throw createErrnoError(-ERRNO.ENOSYS, "symlink", normalized);
    }
    try {
      await this.agentfs.symlink(target, normalized);
      this.fireHook(this.changeHooks.onWrite, normalized);
    } catch (err) {
      throw mapFsError(err, "symlink", normalized);
    }
  }

  symlinkSync(): never {
    throw new Error("AgentFSProvider does not support synchronous operations");
  }

  async realpath(path: string): Promise<string> {
    return normalizeVfsPath(path);
  }

  realpathSync(path: string): string {
    return normalizeVfsPath(path);
  }

  async copyFile(src: string, dest: string): Promise<void> {
    const srcNormalized = normalizeVfsPath(src);
    const destNormalized = normalizeVfsPath(dest);
    try {
      if (this.agentfs.copyFile) {
        await this.agentfs.copyFile(srcNormalized, destNormalized);
      } else {
        const content = await this.agentfs.readFile(srcNormalized);
        await this.agentfs.writeFile(destNormalized, content);
      }
      this.fireHook(this.changeHooks.onWrite, destNormalized);
    } catch (err) {
      throw mapFsError(err, "copyFile", srcNormalized);
    }
  }

  copyFileSync(): never {
    throw new Error("AgentFSProvider does not support synchronous operations");
  }

  async close(): Promise<void> {
    // No cleanup needed — AgentFS manages its own SQLite connection.
  }

  // ---- hook helpers -------------------------------------------------------

  private fireHook(fn: ((...args: string[]) => void | Promise<void>) | undefined, ...args: string[]): void {
    if (!fn) return;
    try {
      const result = fn(...args);
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).catch(() => {});
      }
    } catch {
      // Hooks must not crash the VFS — swallow errors.
    }
  }
}
