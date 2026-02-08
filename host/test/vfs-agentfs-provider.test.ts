import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  AgentFSProvider,
  type AgentFSLike,
  type AgentFSStatsLike,
  type AgentFSFileHandleLike,
  type AgentFSDirEntryLike,
  type AgentFSChangeHooks,
} from "../src/vfs/agentfs-provider";

// ---------------------------------------------------------------------------
// Mock AgentFS — in-memory filesystem implementing AgentFSLike
// ---------------------------------------------------------------------------

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

interface MockInode {
  mode: number;
  content: Buffer;
  target?: string; // symlink target
  ctime: number;
}

function createMockStats(ino: number, inode: MockInode): AgentFSStatsLike {
  const now = inode.ctime;
  return {
    ino,
    mode: inode.mode,
    nlink: 1,
    uid: 0,
    gid: 0,
    size: inode.content.length,
    atime: now,
    mtime: now,
    ctime: now,
    isFile: () => (inode.mode & S_IFMT) === S_IFREG,
    isDirectory: () => (inode.mode & S_IFMT) === S_IFDIR,
    isSymbolicLink: () => (inode.mode & S_IFMT) === S_IFLNK,
  };
}

function createFsError(code: string, syscall: string, fsPath: string): Error {
  const err = new Error(`${code}: ${syscall} '${fsPath}'`) as NodeJS.ErrnoException;
  err.code = code;
  err.syscall = syscall;
  err.path = fsPath;
  return err;
}

class MockFileHandle implements AgentFSFileHandleLike {
  constructor(
    private readonly inode: MockInode,
    private readonly ino: number,
  ) {}

  async pread(offset: number, size: number): Promise<Buffer> {
    const end = Math.min(offset + size, this.inode.content.length);
    if (offset >= this.inode.content.length) return Buffer.alloc(0);
    return Buffer.from(this.inode.content.subarray(offset, end));
  }

  async pwrite(offset: number, data: Buffer): Promise<void> {
    const needed = offset + data.length;
    if (needed > this.inode.content.length) {
      const newBuf = Buffer.alloc(needed);
      this.inode.content.copy(newBuf);
      data.copy(newBuf, offset);
      this.inode.content = newBuf;
    } else {
      data.copy(this.inode.content, offset);
    }
    this.inode.ctime = Math.floor(Date.now() / 1000);
  }

  async truncate(size: number): Promise<void> {
    if (size === 0) {
      this.inode.content = Buffer.alloc(0);
    } else if (size < this.inode.content.length) {
      this.inode.content = Buffer.from(this.inode.content.subarray(0, size));
    } else if (size > this.inode.content.length) {
      const newBuf = Buffer.alloc(size);
      this.inode.content.copy(newBuf);
      this.inode.content = newBuf;
    }
    this.inode.ctime = Math.floor(Date.now() / 1000);
  }

  async fsync(): Promise<void> {}

  async fstat(): Promise<AgentFSStatsLike> {
    return createMockStats(this.ino, this.inode);
  }
}

class MockAgentFS implements AgentFSLike {
  private files = new Map<string, MockInode>();
  private nextIno = 2;

  constructor() {
    this.files.set("/", {
      mode: S_IFDIR | 0o755,
      content: Buffer.alloc(0),
      ctime: Math.floor(Date.now() / 1000),
    });
  }

  private normalize(p: string): string {
    let n = path.posix.normalize(p);
    if (!n.startsWith("/")) n = "/" + n;
    if (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
    return n;
  }

  private parentDir(p: string): string {
    if (p === "/") return "/";
    return path.posix.dirname(p);
  }

  private baseName(p: string): string {
    return path.posix.basename(p);
  }

  private getIno(p: string): number {
    if (p === "/") return 1;
    let ino = 2;
    for (const key of this.files.keys()) {
      if (key === p) return ino;
      ino++;
    }
    return this.nextIno;
  }

  async stat(p: string): Promise<AgentFSStatsLike> {
    const np = this.normalize(p);
    const inode = this.files.get(np);
    if (!inode) throw createFsError("ENOENT", "stat", np);
    return createMockStats(this.getIno(np), inode);
  }

  async lstat(p: string): Promise<AgentFSStatsLike> {
    return this.stat(p);
  }

  async readFile(p: string, options?: BufferEncoding | { encoding?: BufferEncoding }): Promise<Buffer | string> {
    const np = this.normalize(p);
    const inode = this.files.get(np);
    if (!inode) throw createFsError("ENOENT", "open", np);
    if ((inode.mode & S_IFMT) === S_IFDIR) throw createFsError("EISDIR", "open", np);
    const encoding = typeof options === "string" ? options : (options as { encoding?: BufferEncoding })?.encoding;
    if (encoding) return inode.content.toString(encoding);
    return Buffer.from(inode.content);
  }

  async writeFile(
    p: string,
    data: string | Buffer,
    options?: BufferEncoding | { encoding?: BufferEncoding },
  ): Promise<void> {
    const np = this.normalize(p);

    // Ensure parent directories exist
    const parts = np.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current += "/" + parts[i];
      if (!this.files.has(current)) {
        this.files.set(current, {
          mode: S_IFDIR | 0o755,
          content: Buffer.alloc(0),
          ctime: Math.floor(Date.now() / 1000),
        });
        this.nextIno++;
      }
    }

    const encoding = typeof options === "string" ? options : (options as { encoding?: BufferEncoding })?.encoding;
    const buffer = typeof data === "string" ? Buffer.from(data, encoding ?? "utf8") : Buffer.from(data);

    const existing = this.files.get(np);
    if (existing && (existing.mode & S_IFMT) === S_IFDIR) {
      throw createFsError("EISDIR", "open", np);
    }

    this.files.set(np, {
      mode: S_IFREG | 0o644,
      content: buffer,
      ctime: Math.floor(Date.now() / 1000),
    });
    this.nextIno++;
  }

  async readdir(p: string): Promise<string[]> {
    const np = this.normalize(p);
    const inode = this.files.get(np);
    if (!inode) throw createFsError("ENOENT", "scandir", np);
    if ((inode.mode & S_IFMT) !== S_IFDIR) throw createFsError("ENOTDIR", "scandir", np);

    const prefix = np === "/" ? "/" : np + "/";
    const entries: string[] = [];
    for (const key of this.files.keys()) {
      if (key === np) continue;
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.includes("/")) continue; // skip nested
      entries.push(rest);
    }
    return entries.sort();
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
    if (this.files.has(np)) throw createFsError("EEXIST", "mkdir", np);
    const parent = this.parentDir(np);
    if (!this.files.has(parent)) throw createFsError("ENOENT", "mkdir", np);
    this.files.set(np, {
      mode: S_IFDIR | 0o755,
      content: Buffer.alloc(0),
      ctime: Math.floor(Date.now() / 1000),
    });
    this.nextIno++;
  }

  async rmdir(p: string): Promise<void> {
    const np = this.normalize(p);
    const inode = this.files.get(np);
    if (!inode) throw createFsError("ENOENT", "rmdir", np);
    if ((inode.mode & S_IFMT) !== S_IFDIR) throw createFsError("ENOTDIR", "rmdir", np);
    const children = await this.readdir(np);
    if (children.length > 0) throw createFsError("ENOTEMPTY", "rmdir", np);
    this.files.delete(np);
  }

  async unlink(p: string): Promise<void> {
    const np = this.normalize(p);
    const inode = this.files.get(np);
    if (!inode) throw createFsError("ENOENT", "unlink", np);
    if ((inode.mode & S_IFMT) === S_IFDIR) throw createFsError("EISDIR", "unlink", np);
    this.files.delete(np);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const oldNp = this.normalize(oldPath);
    const newNp = this.normalize(newPath);
    const inode = this.files.get(oldNp);
    if (!inode) throw createFsError("ENOENT", "rename", oldNp);
    this.files.delete(oldNp);
    this.files.set(newNp, inode);
  }

  async access(p: string): Promise<void> {
    const np = this.normalize(p);
    if (!this.files.has(np)) throw createFsError("ENOENT", "access", np);
  }

  async open(p: string): Promise<AgentFSFileHandleLike> {
    const np = this.normalize(p);
    const inode = this.files.get(np);
    if (!inode) throw createFsError("ENOENT", "open", np);
    if ((inode.mode & S_IFMT) === S_IFDIR) throw createFsError("EISDIR", "open", np);
    return new MockFileHandle(inode, this.getIno(np));
  }

  async symlink(target: string, linkpath: string): Promise<void> {
    const np = this.normalize(linkpath);
    if (this.files.has(np)) throw createFsError("EEXIST", "open", np);
    this.files.set(np, {
      mode: S_IFLNK | 0o777,
      content: Buffer.alloc(0),
      target,
      ctime: Math.floor(Date.now() / 1000),
    });
    this.nextIno++;
  }

  async readlink(p: string): Promise<string> {
    const np = this.normalize(p);
    const inode = this.files.get(np);
    if (!inode) throw createFsError("ENOENT", "open", np);
    if ((inode.mode & S_IFMT) !== S_IFLNK) throw createFsError("EINVAL", "open", np);
    return inode.target!;
  }

  async copyFile(src: string, dest: string): Promise<void> {
    const srcNp = this.normalize(src);
    const destNp = this.normalize(dest);
    const inode = this.files.get(srcNp);
    if (!inode) throw createFsError("ENOENT", "copyfile", srcNp);
    this.files.set(destNp, {
      mode: inode.mode,
      content: Buffer.from(inode.content),
      ctime: Math.floor(Date.now() / 1000),
    });
    this.nextIno++;
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function createProvider(hooks?: AgentFSChangeHooks): { provider: AgentFSProvider; mock: MockAgentFS } {
  const mock = new MockAgentFS();
  const provider = new AgentFSProvider(mock, hooks);
  return { provider, mock };
}

const isCode = (code: string) => (err: unknown) => {
  const e = err as NodeJS.ErrnoException;
  return e.code === code || e.code === `ERRNO_${Math.abs(e.errno ?? 0)}`;
};

// ---------------------------------------------------------------------------
// B-TEST-1: stat("/") returns directory info
// ---------------------------------------------------------------------------

test("B-TEST-1: stat('/') returns directory info", async () => {
  const { provider } = createProvider();
  const stats = await provider.stat("/");
  assert.equal(stats.isDirectory(), true);
  assert.equal(stats.isFile(), false);
  assert.ok(stats.mode);
});

// ---------------------------------------------------------------------------
// B-TEST-2: writeFile + readFile round-trip
// ---------------------------------------------------------------------------

test("B-TEST-2: writeFile + readFile returns correct content", async () => {
  const { provider } = createProvider();

  await provider.writeFile!("/test.txt", "hello");
  const content = await provider.readFile!("/test.txt", { encoding: "utf8" });
  assert.equal(content, "hello");

  // Binary round-trip
  const buf = Buffer.from([0x01, 0x02, 0x03]);
  await provider.writeFile!("/bin.dat", buf);
  const result = await provider.readFile!("/bin.dat");
  assert.ok(Buffer.isBuffer(result));
  assert.deepEqual(result, buf);
});

// ---------------------------------------------------------------------------
// B-TEST-3: mkdir + readdir
// ---------------------------------------------------------------------------

test("B-TEST-3: mkdir + readdir includes new directory", async () => {
  const { provider } = createProvider();

  await provider.mkdir("/subdir");
  const entries = await provider.readdir("/");
  assert.ok(entries.includes("subdir"));

  const stats = await provider.stat("/subdir");
  assert.equal(stats.isDirectory(), true);
});

// ---------------------------------------------------------------------------
// B-TEST-4: unlink + stat → ENOENT
// ---------------------------------------------------------------------------

test("B-TEST-4: unlink then stat throws ENOENT", async () => {
  const { provider } = createProvider();

  await provider.writeFile!("/test.txt", "hello");
  await provider.unlink("/test.txt");
  await assert.rejects(() => provider.stat("/test.txt"), isCode("ENOENT"));
});

// ---------------------------------------------------------------------------
// B-TEST-5: rename
// ---------------------------------------------------------------------------

test("B-TEST-5: rename moves file, old path gone, new path has content", async () => {
  const { provider } = createProvider();

  await provider.writeFile!("/a.txt", "content-a");
  await provider.rename("/a.txt", "/b.txt");

  await assert.rejects(() => provider.stat("/a.txt"), isCode("ENOENT"));

  const content = await provider.readFile!("/b.txt", { encoding: "utf8" });
  assert.equal(content, "content-a");
});

// ---------------------------------------------------------------------------
// B-TEST-6: File handles — open → write → read → close
// ---------------------------------------------------------------------------

test("B-TEST-6: file handle write then read cycle", async () => {
  const { provider } = createProvider();

  // Open for writing (creates the file)
  const wh = await provider.open("/handle.txt", "w+");
  await wh.writeFile("file-handle-data");
  await wh.close();

  // Open for reading
  const rh = await provider.open("/handle.txt", "r");
  const content = await rh.readFile({ encoding: "utf8" });
  assert.equal(content, "file-handle-data");
  await rh.close();
});

test("B-TEST-6b: file handle positional read/write", async () => {
  const { provider } = createProvider();

  const wh = await provider.open("/pos.txt", "w+");
  const writeBuf = Buffer.from("ABCDEFGH");
  await wh.write(writeBuf, 0, writeBuf.length);
  await wh.close();

  const rh = await provider.open("/pos.txt", "r");
  const readBuf = Buffer.alloc(4);
  const { bytesRead } = await rh.read(readBuf, 0, 4);
  assert.equal(bytesRead, 4);
  assert.equal(readBuf.toString(), "ABCD");

  // Read next 4 bytes (position advances)
  const readBuf2 = Buffer.alloc(4);
  const { bytesRead: bytesRead2 } = await rh.read(readBuf2, 0, 4);
  assert.equal(bytesRead2, 4);
  assert.equal(readBuf2.toString(), "EFGH");
  await rh.close();
});

test("B-TEST-6c: file handle truncate", async () => {
  const { provider } = createProvider();

  const wh = await provider.open("/trunc.txt", "w+");
  await wh.writeFile("long content here");
  await wh.truncate(4);
  await wh.close();

  const content = await provider.readFile!("/trunc.txt", { encoding: "utf8" });
  assert.equal(content, "long");
});

test("B-TEST-6d: file handle stat", async () => {
  const { provider } = createProvider();

  await provider.writeFile!("/statfile.txt", "12345");
  const fh = await provider.open("/statfile.txt", "r");
  const stats = await fh.stat();
  assert.equal(stats.size, 5);
  assert.equal(stats.isFile(), true);
  await fh.close();
});

test("B-TEST-6e: closed handle throws", async () => {
  const { provider } = createProvider();

  const fh = await provider.open("/closed.txt", "w+");
  await fh.close();
  assert.equal(fh.closed, true);
  await assert.rejects(() => fh.readFile());
});

// ---------------------------------------------------------------------------
// B-TEST-7: POSIX error codes
// ---------------------------------------------------------------------------

test("B-TEST-7: access non-existent file → ENOENT", async () => {
  const { provider } = createProvider();
  await assert.rejects(() => provider.stat("/nope"), isCode("ENOENT"));
  await assert.rejects(() => provider.access!("/nope"), isCode("ENOENT"));
});

test("B-TEST-7b: mkdir on existing path → EEXIST", async () => {
  const { provider } = createProvider();
  await provider.mkdir("/dir");
  await assert.rejects(() => provider.mkdir("/dir"), isCode("EEXIST"));
});

test("B-TEST-7c: unlink directory → EISDIR", async () => {
  const { provider } = createProvider();
  await provider.mkdir("/dir");
  await assert.rejects(() => provider.unlink("/dir"), isCode("EISDIR"));
});

test("B-TEST-7d: rmdir non-empty → ENOTEMPTY", async () => {
  const { provider } = createProvider();
  await provider.mkdir("/dir");
  await provider.writeFile!("/dir/file.txt", "x");
  await assert.rejects(() => provider.rmdir("/dir"), isCode("ENOTEMPTY"));
});

test("B-TEST-7e: open non-existent for reading → ENOENT", async () => {
  const { provider } = createProvider();
  await assert.rejects(() => provider.open("/missing.txt", "r"), isCode("ENOENT"));
});

test("B-TEST-7f: open with exclusive flag on existing → EEXIST", async () => {
  const { provider } = createProvider();
  await provider.writeFile!("/exists.txt", "data");
  await assert.rejects(() => provider.open("/exists.txt", "wx"), isCode("EEXIST"));
});

// ---------------------------------------------------------------------------
// B-TEST-8 & 9: COW overlay (deferred — requires real AgentFS + git repo)
// ---------------------------------------------------------------------------

test("B-TEST-8/9: COW overlay (placeholder — requires real AgentFS integration)", { skip: "Requires real AgentFS SDK with SQLite backend" }, async () => {
  // COW overlay testing requires:
  // 1. Real AgentFS.open({ path: 'db', baseDir: '/repo' })
  // 2. A git repository as base layer
  // Will be tested as integration tests with the actual SDK.
});

// ---------------------------------------------------------------------------
// B-TEST-10: Workspace initialization path
// ---------------------------------------------------------------------------

test("B-TEST-10: initializeWorkspace creates provider with initial files", async () => {
  // We can test the initializeWorkspace function with our mock factory
  const { initializeWorkspace } = await import("../src/vfs/agentfs-provider");

  const tmpDir = `/tmp/gondolin-test-${Date.now()}`;
  const dbPath = `${tmpDir}/workspace.db`;

  try {
    const provider = await initializeWorkspace(
      async (_dbPath: string) => {
        // Return a mock AgentFS for testing
        return new MockAgentFS();
      },
      {
        workspaceId: "test-ws",
        dbPath,
        files: {
          "/hello.txt": "world",
          "/src/main.ts": "console.log('hi')",
        },
      },
    );

    // Verify the provider works and files were created
    const content = await provider.readFile!("/hello.txt", { encoding: "utf8" });
    assert.equal(content, "world");

    const srcContent = await provider.readFile!("/src/main.ts", { encoding: "utf8" });
    assert.equal(srcContent, "console.log('hi')");

    // Verify workspace directory was created
    const fs = await import("node:fs");
    assert.ok(fs.existsSync(tmpDir));
  } finally {
    const fs = await import("node:fs");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B-TEST-11: initializeWorkspace with git repo (deferred)
// ---------------------------------------------------------------------------

test("B-TEST-11: initializeWorkspace with git repo (placeholder)", { skip: "Requires real git repo + AgentFS SDK" }, async () => {
  // Will be tested as integration tests.
});

// ---------------------------------------------------------------------------
// B-TEST-12: VFS hooks fire on mutations
// ---------------------------------------------------------------------------

test("B-TEST-12: VFS hooks fire on write/delete/rename/mkdir", async () => {
  const events: string[] = [];

  const hooks: AgentFSChangeHooks = {
    onWrite: (p) => { events.push(`write:${p}`); },
    onDelete: (p) => { events.push(`delete:${p}`); },
    onRename: (oldP, newP) => { events.push(`rename:${oldP}:${newP}`); },
    onMkdir: (p) => { events.push(`mkdir:${p}`); },
  };

  const { provider } = createProvider(hooks);

  await provider.writeFile!("/file.txt", "data");
  await provider.mkdir("/dir");
  await provider.rename("/file.txt", "/moved.txt");
  await provider.unlink("/moved.txt");
  await provider.rmdir("/dir");

  assert.deepEqual(events, [
    "write:/file.txt",
    "mkdir:/dir",
    "rename:/file.txt:/moved.txt",
    "delete:/moved.txt",
    "delete:/dir",
  ]);
});

test("B-TEST-12b: async hooks don't block operations", async () => {
  let hookResolved = false;

  const hooks: AgentFSChangeHooks = {
    onWrite: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      hookResolved = true;
    },
  };

  const { provider } = createProvider(hooks);
  await provider.writeFile!("/file.txt", "data");

  // Hook should be fired but not awaited (fire-and-forget)
  // The write should complete before the hook resolves
  assert.equal(hookResolved, false);

  // Wait for the hook to complete
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(hookResolved, true);
});

test("B-TEST-12c: hook errors don't crash operations", async () => {
  const hooks: AgentFSChangeHooks = {
    onWrite: () => { throw new Error("hook crash"); },
  };

  const { provider } = createProvider(hooks);
  // Should not throw despite the hook error
  await provider.writeFile!("/file.txt", "data");
  const content = await provider.readFile!("/file.txt", { encoding: "utf8" });
  assert.equal(content, "data");
});

test("B-TEST-12d: hooks fire on open with write flag (file creation)", async () => {
  const events: string[] = [];
  const hooks: AgentFSChangeHooks = {
    onWrite: (p) => { events.push(`write:${p}`); },
  };

  const { provider } = createProvider(hooks);

  // Opening with 'w' flag creates the file → should fire onWrite
  const fh = await provider.open("/created.txt", "w");
  await fh.close();

  assert.ok(events.includes("write:/created.txt"));
});

// ---------------------------------------------------------------------------
// B-TEST-13: Concurrent reads don't deadlock
// ---------------------------------------------------------------------------

test("B-TEST-13: concurrent reads complete without deadlock", async () => {
  const { provider } = createProvider();

  // Create some test files
  for (let i = 0; i < 10; i++) {
    await provider.writeFile!(`/file-${i}.txt`, `content-${i}`);
  }

  // Read all files concurrently
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      provider.readFile!(`/file-${i}.txt`, { encoding: "utf8" }),
    ),
  );

  for (let i = 0; i < 10; i++) {
    assert.equal(results[i], `content-${i}`);
  }
});

test("B-TEST-13b: concurrent reads and writes interleave safely", async () => {
  const { provider } = createProvider();

  // Write initial files
  for (let i = 0; i < 5; i++) {
    await provider.writeFile!(`/rw-${i}.txt`, `initial-${i}`);
  }

  // Interleave reads and writes
  const promises: Promise<unknown>[] = [];
  for (let i = 0; i < 5; i++) {
    promises.push(provider.readFile!(`/rw-${i}.txt`, { encoding: "utf8" }));
    promises.push(provider.writeFile!(`/rw-new-${i}.txt`, `new-${i}`));
  }

  await Promise.all(promises);

  // Verify new files exist
  for (let i = 0; i < 5; i++) {
    const content = await provider.readFile!(`/rw-new-${i}.txt`, { encoding: "utf8" });
    assert.equal(content, `new-${i}`);
  }
});

// ---------------------------------------------------------------------------
// Additional provider property tests
// ---------------------------------------------------------------------------

test("provider properties", async () => {
  const { provider } = createProvider();
  assert.equal(provider.readonly, false);
  assert.equal(provider.supportsSymlinks, true);
  assert.equal(provider.supportsWatch, false);
});

test("sync operations throw", () => {
  const { provider } = createProvider();
  assert.throws(() => provider.openSync("/x", "r"), /synchronous/);
  assert.throws(() => provider.statSync("/"), /synchronous/);
  assert.throws(() => provider.lstatSync("/"), /synchronous/);
  assert.throws(() => provider.readdirSync("/"), /synchronous/);
  assert.throws(() => provider.mkdirSync("/x"), /synchronous/);
  assert.throws(() => provider.rmdirSync("/x"), /synchronous/);
  assert.throws(() => provider.unlinkSync("/x"), /synchronous/);
  assert.throws(() => provider.renameSync("/x", "/y"), /synchronous/);
});

test("readdir with withFileTypes returns Dirent-like objects", async () => {
  const { provider } = createProvider();

  await provider.mkdir("/mydir");
  await provider.writeFile!("/myfile.txt", "data");

  const entries = await provider.readdir("/", { withFileTypes: true });
  assert.equal(entries.length, 2);

  const dirEntry = entries.find((e) => (e as { name: string }).name === "mydir") as unknown as { name: string; isDirectory: () => boolean; isFile: () => boolean };
  const fileEntry = entries.find((e) => (e as { name: string }).name === "myfile.txt") as unknown as { name: string; isDirectory: () => boolean; isFile: () => boolean };

  assert.ok(dirEntry);
  assert.ok(fileEntry);
  assert.equal(dirEntry.isDirectory(), true);
  assert.equal(dirEntry.isFile(), false);
  assert.equal(fileEntry.isFile(), true);
  assert.equal(fileEntry.isDirectory(), false);
});

test("append mode opens at end of file", async () => {
  const { provider } = createProvider();

  await provider.writeFile!("/append.txt", "hello");

  const fh = await provider.open("/append.txt", "a");
  assert.equal(fh.position, 5); // position at end
  const writeBuf = Buffer.from(" world");
  await fh.write(writeBuf, 0, writeBuf.length);
  await fh.close();

  const content = await provider.readFile!("/append.txt", { encoding: "utf8" });
  assert.equal(content, "hello world");
});

test("realpath returns normalized path", async () => {
  const { provider } = createProvider();
  const resolved = await provider.realpath!("/a/../b/./c");
  assert.equal(resolved, "/b/c");
});

test("getFilesystem returns the underlying AgentFS", () => {
  const { provider, mock } = createProvider();
  assert.equal(provider.getFilesystem(), mock);
});

test("recursive mkdir creates intermediate directories", async () => {
  const { provider } = createProvider();
  await provider.mkdir("/a/b/c", { recursive: true });

  const statsA = await provider.stat("/a");
  assert.equal(statsA.isDirectory(), true);

  const statsB = await provider.stat("/a/b");
  assert.equal(statsB.isDirectory(), true);

  const statsC = await provider.stat("/a/b/c");
  assert.equal(statsC.isDirectory(), true);
});

test("copyFile duplicates content", async () => {
  const { provider } = createProvider();
  await provider.writeFile!("/src.txt", "source data");
  await provider.copyFile!("/src.txt", "/dst.txt");

  const content = await provider.readFile!("/dst.txt", { encoding: "utf8" });
  assert.equal(content, "source data");
});
