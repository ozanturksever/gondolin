import path from "node:path";

import type {
  AgentFSLike,
  AgentFSStatsLike,
  AgentFSFileHandleLike,
  AgentFSDirEntryLike,
} from "./agentfs-provider";

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

function createCowError(code: string, syscall: string, fsPath: string): Error {
  const err = new Error(`${code}: ${syscall} '${fsPath}'`) as NodeJS.ErrnoException;
  err.code = code;
  err.syscall = syscall;
  err.path = fsPath;
  return err;
}

export interface OverlayEntry {
  type: "added" | "modified" | "deleted";
  content: Buffer;
  mode: number;
  isDir: boolean;
  target?: string;
  ctime: number;
}

export interface OverlayChange {
  path: string;
  type: "added" | "modified" | "deleted";
}

class CowFileHandle implements AgentFSFileHandleLike {
  private overlayEntry: OverlayEntry | null;
  private baseContent: Buffer | null;
  private readonly baseMode: number;

  constructor(
    private readonly cow: CowOverlayFS,
    private readonly filePath: string,
    entry: OverlayEntry | null,
    baseContent: Buffer | null,
    baseMode: number,
  ) {
    this.overlayEntry = entry;
    this.baseContent = baseContent;
    this.baseMode = baseMode;
  }

  private getContent(): Buffer {
    if (this.overlayEntry) return this.overlayEntry.content;
    return this.baseContent!;
  }

  private ensureOverlay(): OverlayEntry {
    if (!this.overlayEntry) {
      this.overlayEntry = {
        type: "modified",
        content: Buffer.from(this.baseContent!),
        mode: this.baseMode,
        isDir: false,
        ctime: Math.floor(Date.now() / 1000),
      };
      this.cow._putEntry(this.filePath, this.overlayEntry);
      this.baseContent = null;
    }
    return this.overlayEntry;
  }

  async pread(offset: number, size: number): Promise<Buffer> {
    const content = this.getContent();
    const end = Math.min(offset + size, content.length);
    if (offset >= content.length) return Buffer.alloc(0);
    return Buffer.from(content.subarray(offset, end));
  }

  async pwrite(offset: number, data: Buffer): Promise<void> {
    const entry = this.ensureOverlay();
    const needed = offset + data.length;
    if (needed > entry.content.length) {
      const newBuf = Buffer.alloc(needed);
      entry.content.copy(newBuf);
      data.copy(newBuf, offset);
      entry.content = newBuf;
    } else {
      data.copy(entry.content, offset);
    }
    entry.ctime = Math.floor(Date.now() / 1000);
  }

  async truncate(size: number): Promise<void> {
    const entry = this.ensureOverlay();
    if (size === 0) {
      entry.content = Buffer.alloc(0);
    } else if (size < entry.content.length) {
      entry.content = Buffer.from(entry.content.subarray(0, size));
    } else if (size > entry.content.length) {
      const newBuf = Buffer.alloc(size);
      entry.content.copy(newBuf);
      entry.content = newBuf;
    }
    entry.ctime = Math.floor(Date.now() / 1000);
  }

  async fsync(): Promise<void> {}

  async fstat(): Promise<AgentFSStatsLike> {
    const content = this.getContent();
    const mode = this.overlayEntry?.mode ?? this.baseMode;
    const ctime = this.overlayEntry?.ctime ?? Math.floor(Date.now() / 1000);
    return {
      ino: 0,
      mode,
      nlink: 1,
      uid: 0,
      gid: 0,
      size: content.length,
      atime: ctime,
      mtime: ctime,
      ctime,
      isFile: () => (mode & S_IFMT) === S_IFREG,
      isDirectory: () => (mode & S_IFMT) === S_IFDIR,
      isSymbolicLink: () => (mode & S_IFMT) === S_IFLNK,
    };
  }
}

/**
 * Copy-on-Write overlay filesystem.
 *
 * Wraps a read-only base `AgentFSLike` and tracks all modifications
 * (adds, edits, deletes) in an in-memory overlay.  The base layer is
 * never mutated.
 *
 * Use `listChanges()` to enumerate what changed, `diff()` to produce
 * a unified patch, and `reset()` to discard all overlay state.
 */
export class CowOverlayFS implements AgentFSLike {
  private readonly overlay = new Map<string, OverlayEntry>();

  constructor(private readonly base: AgentFSLike) {}

  /** @internal — used by CowFileHandle to register copy-up entries */
  _putEntry(p: string, entry: OverlayEntry): void {
    this.overlay.set(p, entry);
  }

  private normalize(p: string): string {
    let n = path.posix.normalize(p);
    if (!n.startsWith("/")) n = "/" + n;
    if (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
    return n;
  }

  private entryToStats(entry: OverlayEntry): AgentFSStatsLike {
    const mode = entry.mode;
    return {
      ino: 0,
      mode,
      nlink: 1,
      uid: 0,
      gid: 0,
      size: entry.content.length,
      atime: entry.ctime,
      mtime: entry.ctime,
      ctime: entry.ctime,
      isFile: () => (mode & S_IFMT) === S_IFREG,
      isDirectory: () => (mode & S_IFMT) === S_IFDIR,
      isSymbolicLink: () => (mode & S_IFMT) === S_IFLNK,
    };
  }

  private async resolveType(np: string): Promise<"added" | "modified"> {
    try {
      await this.base.stat(np);
      return "modified";
    } catch {
      return "added";
    }
  }

  // -- overlay management ---------------------------------------------------

  listChanges(): OverlayChange[] {
    const changes: OverlayChange[] = [];
    for (const [p, entry] of this.overlay) {
      if (entry.isDir) continue;
      changes.push({ path: p, type: entry.type });
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  async diff(): Promise<string> {
    const lines: string[] = [];

    const sorted = [...this.overlay.entries()]
      .filter(([, e]) => !e.isDir)
      .sort(([a], [b]) => a.localeCompare(b));

    for (const [p, entry] of sorted) {
      if (entry.type === "added") {
        lines.push(`diff --git a${p} b${p}`);
        lines.push("new file mode 100644");
        lines.push("--- /dev/null");
        lines.push(`+++ b${p}`);
        const contentLines = entry.content.toString("utf8").split("\n");
        lines.push(`@@ -0,0 +1,${contentLines.length} @@`);
        for (const l of contentLines) lines.push(`+${l}`);
        lines.push("");
      } else if (entry.type === "deleted") {
        let origLines: string[] = ["[content deleted]"];
        try {
          const orig = await this.base.readFile(p);
          origLines = (orig as Buffer).toString("utf8").split("\n");
        } catch {}
        lines.push(`diff --git a${p} b${p}`);
        lines.push("deleted file mode 100644");
        lines.push(`--- a${p}`);
        lines.push("+++ /dev/null");
        lines.push(`@@ -1,${origLines.length} +0,0 @@`);
        for (const l of origLines) lines.push(`-${l}`);
        lines.push("");
      } else if (entry.type === "modified") {
        let origLines: string[] = [];
        try {
          const orig = await this.base.readFile(p);
          origLines = (orig as Buffer).toString("utf8").split("\n");
        } catch {}
        const newLines = entry.content.toString("utf8").split("\n");
        lines.push(`diff --git a${p} b${p}`);
        lines.push(`--- a${p}`);
        lines.push(`+++ b${p}`);
        lines.push(`@@ -1,${origLines.length} +1,${newLines.length} @@`);
        for (const l of origLines) lines.push(`-${l}`);
        for (const l of newLines) lines.push(`+${l}`);
        lines.push("");
      }
    }

    return lines.join("\n");
  }

  reset(): void {
    this.overlay.clear();
  }

  // -- AgentFSLike implementation -------------------------------------------

  async stat(p: string): Promise<AgentFSStatsLike> {
    const np = this.normalize(p);
    const entry = this.overlay.get(np);
    if (entry) {
      if (entry.type === "deleted") throw createCowError("ENOENT", "stat", np);
      return this.entryToStats(entry);
    }
    return this.base.stat(np);
  }

  async lstat(p: string): Promise<AgentFSStatsLike> {
    const np = this.normalize(p);
    const entry = this.overlay.get(np);
    if (entry) {
      if (entry.type === "deleted") throw createCowError("ENOENT", "lstat", np);
      return this.entryToStats(entry);
    }
    return this.base.lstat(np);
  }

  async readFile(p: string, options?: BufferEncoding | { encoding?: BufferEncoding }): Promise<Buffer | string> {
    const np = this.normalize(p);
    const entry = this.overlay.get(np);

    if (entry) {
      if (entry.type === "deleted") throw createCowError("ENOENT", "open", np);
      if (entry.isDir) throw createCowError("EISDIR", "open", np);
      const encoding = typeof options === "string" ? options : options?.encoding;
      if (encoding) return entry.content.toString(encoding);
      return Buffer.from(entry.content);
    }

    if (typeof options === "string") return this.base.readFile(np, options);
    if (options?.encoding) return this.base.readFile(np, options as { encoding: BufferEncoding });
    return this.base.readFile(np);
  }

  async writeFile(
    p: string,
    data: string | Buffer,
    options?: BufferEncoding | { encoding?: BufferEncoding },
  ): Promise<void> {
    const np = this.normalize(p);
    const encoding = typeof options === "string" ? options : options?.encoding;
    const buffer = typeof data === "string" ? Buffer.from(data, encoding ?? "utf8") : Buffer.from(data);
    const now = Math.floor(Date.now() / 1000);

    // Ensure parent directories exist in overlay
    const parts = np.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current += "/" + parts[i];
      const parentEntry = this.overlay.get(current);
      if (parentEntry?.type === "deleted") {
        parentEntry.type = "modified";
        parentEntry.isDir = true;
        parentEntry.mode = S_IFDIR | 0o755;
        parentEntry.ctime = now;
      } else if (!parentEntry) {
        try {
          await this.base.stat(current);
        } catch {
          this.overlay.set(current, {
            type: "added",
            content: Buffer.alloc(0),
            mode: S_IFDIR | 0o755,
            isDir: true,
            ctime: now,
          });
        }
      }
    }

    const existing = this.overlay.get(np);
    let type: "added" | "modified";
    if (existing) {
      type = existing.type === "added" ? "added" : "modified";
    } else {
      type = await this.resolveType(np);
    }

    this.overlay.set(np, {
      type,
      content: buffer,
      mode: S_IFREG | 0o644,
      isDir: false,
      ctime: now,
    });
  }

  async readdir(p: string): Promise<string[]> {
    const np = this.normalize(p);
    const entry = this.overlay.get(np);

    if (entry?.type === "deleted") throw createCowError("ENOENT", "scandir", np);

    const isOverlayOnlyDir = entry && entry.isDir && entry.type === "added";

    let baseEntries: string[] = [];
    if (!isOverlayOnlyDir) {
      try {
        baseEntries = await this.base.readdir(np);
      } catch {
        if (!entry) throw createCowError("ENOENT", "scandir", np);
      }
    }

    const prefix = np === "/" ? "/" : np + "/";
    const result = new Set<string>();

    for (const name of baseEntries) {
      const childPath = np === "/" ? `/${name}` : `${np}/${name}`;
      const childEntry = this.overlay.get(childPath);
      if (childEntry?.type !== "deleted") result.add(name);
    }

    for (const [overlayPath, overlayEntry] of this.overlay) {
      if (overlayEntry.type === "deleted") continue;
      if (!overlayPath.startsWith(prefix)) continue;
      const rest = overlayPath.slice(prefix.length);
      if (rest.includes("/")) continue;
      result.add(rest);
    }

    return [...result].sort();
  }

  async readdirPlus(p: string): Promise<AgentFSDirEntryLike[]> {
    const np = this.normalize(p);
    const names = await this.readdir(np);
    const entries: AgentFSDirEntryLike[] = [];
    for (const name of names) {
      const childPath = np === "/" ? `/${name}` : `${np}/${name}`;
      const stats = await this.stat(childPath);
      entries.push({ name, stats });
    }
    return entries;
  }

  async mkdir(p: string): Promise<void> {
    const np = this.normalize(p);
    const entry = this.overlay.get(np);

    if (entry && entry.type !== "deleted") throw createCowError("EEXIST", "mkdir", np);

    if (!entry) {
      try {
        await this.base.stat(np);
        throw createCowError("EEXIST", "mkdir", np);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") throw err;
      }
    }

    const type = await this.resolveType(np);
    this.overlay.set(np, {
      type,
      content: Buffer.alloc(0),
      mode: S_IFDIR | 0o755,
      isDir: true,
      ctime: Math.floor(Date.now() / 1000),
    });
  }

  async rmdir(p: string): Promise<void> {
    const np = this.normalize(p);

    const stats = await this.stat(np);
    if (!stats.isDirectory()) throw createCowError("ENOTDIR", "rmdir", np);

    const children = await this.readdir(np);
    if (children.length > 0) throw createCowError("ENOTEMPTY", "rmdir", np);

    const entry = this.overlay.get(np);
    if (entry?.type === "added") {
      this.overlay.delete(np);
    } else {
      this.overlay.set(np, {
        type: "deleted",
        content: Buffer.alloc(0),
        mode: 0,
        isDir: true,
        ctime: Math.floor(Date.now() / 1000),
      });
    }
  }

  async unlink(p: string): Promise<void> {
    const np = this.normalize(p);

    const stats = await this.stat(np);
    if (stats.isDirectory()) throw createCowError("EISDIR", "unlink", np);

    const entry = this.overlay.get(np);
    if (entry?.type === "added") {
      this.overlay.delete(np);
    } else {
      this.overlay.set(np, {
        type: "deleted",
        content: Buffer.alloc(0),
        mode: 0,
        isDir: false,
        ctime: Math.floor(Date.now() / 1000),
      });
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const oldNp = this.normalize(oldPath);
    const newNp = this.normalize(newPath);

    const stats = await this.stat(oldNp);
    if (stats.isDirectory()) throw createCowError("ENOSYS", "rename", oldNp);

    const oldEntry = this.overlay.get(oldNp);
    let content: Buffer;
    let mode: number;

    if (oldEntry && oldEntry.type !== "deleted") {
      content = Buffer.from(oldEntry.content);
      mode = oldEntry.mode;
    } else {
      content = Buffer.from(await this.base.readFile(oldNp) as Buffer);
      mode = stats.mode;
    }

    const newType = await this.resolveType(newNp);
    const now = Math.floor(Date.now() / 1000);

    this.overlay.set(newNp, { type: newType, content, mode, isDir: false, ctime: now });

    if (oldEntry?.type === "added") {
      this.overlay.delete(oldNp);
    } else {
      this.overlay.set(oldNp, { type: "deleted", content: Buffer.alloc(0), mode: 0, isDir: false, ctime: now });
    }
  }

  async access(p: string): Promise<void> {
    const np = this.normalize(p);
    const entry = this.overlay.get(np);
    if (entry) {
      if (entry.type === "deleted") throw createCowError("ENOENT", "access", np);
      return;
    }
    return this.base.access(np);
  }

  async open(p: string): Promise<AgentFSFileHandleLike> {
    const np = this.normalize(p);
    const entry = this.overlay.get(np);

    if (entry) {
      if (entry.type === "deleted") throw createCowError("ENOENT", "open", np);
      if (entry.isDir) throw createCowError("EISDIR", "open", np);
      return new CowFileHandle(this, np, entry, null, entry.mode);
    }

    const stats = await this.base.stat(np);
    if (stats.isDirectory()) throw createCowError("EISDIR", "open", np);
    const content = await this.base.readFile(np) as Buffer;
    return new CowFileHandle(this, np, null, Buffer.from(content), stats.mode);
  }

  async copyFile(src: string, dest: string): Promise<void> {
    const srcNp = this.normalize(src);
    const destNp = this.normalize(dest);
    const entry = this.overlay.get(srcNp);

    let content: Buffer;
    let mode: number;
    if (entry && entry.type !== "deleted") {
      content = Buffer.from(entry.content);
      mode = entry.mode;
    } else if (!entry) {
      const stats = await this.base.stat(srcNp);
      content = Buffer.from(await this.base.readFile(srcNp) as Buffer);
      mode = stats.mode;
    } else {
      throw createCowError("ENOENT", "copyfile", srcNp);
    }

    const destType = await this.resolveType(destNp);
    this.overlay.set(destNp, {
      type: destType,
      content,
      mode,
      isDir: false,
      ctime: Math.floor(Date.now() / 1000),
    });
  }

  async symlink(target: string, linkpath: string): Promise<void> {
    const np = this.normalize(linkpath);
    const existing = this.overlay.get(np);
    if (existing && existing.type !== "deleted") throw createCowError("EEXIST", "symlink", np);
    if (!existing) {
      try {
        await this.base.stat(np);
        throw createCowError("EEXIST", "symlink", np);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") throw err;
      }
    }

    this.overlay.set(np, {
      type: "added",
      content: Buffer.alloc(0),
      mode: S_IFLNK | 0o777,
      isDir: false,
      target,
      ctime: Math.floor(Date.now() / 1000),
    });
  }

  async readlink(p: string): Promise<string> {
    const np = this.normalize(p);
    const entry = this.overlay.get(np);
    if (entry) {
      if (entry.type === "deleted") throw createCowError("ENOENT", "readlink", np);
      if (!entry.target) throw createCowError("EINVAL", "readlink", np);
      return entry.target;
    }
    if (!this.base.readlink) throw createCowError("ENOSYS", "readlink", np);
    return this.base.readlink(np);
  }

  async rm(p: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> {
    const np = this.normalize(p);
    const force = options?.force ?? false;
    const recursive = options?.recursive ?? false;

    let stats: AgentFSStatsLike;
    try {
      stats = await this.stat(np);
    } catch {
      if (force) return;
      throw createCowError("ENOENT", "rm", np);
    }

    if (stats.isDirectory()) {
      if (!recursive) throw createCowError("EISDIR", "rm", np);
      const children = await this.readdir(np);
      for (const child of children) {
        const childPath = np === "/" ? `/${child}` : `${np}/${child}`;
        await this.rm(childPath, { force: true, recursive: true });
      }
    }

    const entry = this.overlay.get(np);
    if (entry?.type === "added") {
      this.overlay.delete(np);
    } else {
      this.overlay.set(np, {
        type: "deleted",
        content: Buffer.alloc(0),
        mode: 0,
        isDir: stats.isDirectory(),
        ctime: Math.floor(Date.now() / 1000),
      });
    }
  }
}
