import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  ConvexFileSync,
  type ConvexSyncClient,
  type FileSyncUpdate,
  type FileSyncDeletion,
  type FileSyncEvent,
} from "../src/convex-file-sync";
import type {
  AgentFSLike,
  AgentFSStatsLike,
  AgentFSFileHandleLike,
} from "../src/vfs/agentfs-provider";

// ---------------------------------------------------------------------------
// Mock AgentFS (subset reused from agent-tools-edge.test.ts)
// ---------------------------------------------------------------------------

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

interface MockInode {
  mode: number;
  content: Buffer;
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
    isSymbolicLink: () => false,
  };
}

function createFsError(code: string, syscall: string, fsPath: string): Error {
  const err = new Error(`${code}: ${syscall} '${fsPath}'`) as NodeJS.ErrnoException;
  err.code = code;
  err.syscall = syscall;
  err.path = fsPath;
  return err;
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
      if (rest.includes("/")) continue;
      entries.push(rest);
    }
    return entries.sort();
  }

  async mkdir(p: string): Promise<void> {
    const np = this.normalize(p);
    if (this.files.has(np)) throw createFsError("EEXIST", "mkdir", np);
    this.files.set(np, {
      mode: S_IFDIR | 0o755,
      content: Buffer.alloc(0),
      ctime: Math.floor(Date.now() / 1000),
    });
    this.nextIno++;
  }

  async rmdir(p: string): Promise<void> {
    const np = this.normalize(p);
    this.files.delete(np);
  }

  async unlink(p: string): Promise<void> {
    const np = this.normalize(p);
    const inode = this.files.get(np);
    if (!inode) throw createFsError("ENOENT", "unlink", np);
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
    throw new Error("open not needed for sync tests");
  }
}

// ---------------------------------------------------------------------------
// Mock ConvexSyncClient — records calls for assertions
// ---------------------------------------------------------------------------

class MockConvexSyncClient implements ConvexSyncClient {
  syncCalls: Array<{ workspaceId: string; updates: FileSyncUpdate[] }> = [];
  deleteCalls: Array<{ workspaceId: string; deletions: FileSyncDeletion[] }> = [];
  eventCalls: Array<{ workspaceId: string; events: FileSyncEvent[] }> = [];

  shouldFail = false;
  failOnSync = false;

  async syncFiles(workspaceId: string, updates: FileSyncUpdate[]): Promise<void> {
    if (this.shouldFail || this.failOnSync) throw new Error("sync failed");
    this.syncCalls.push({ workspaceId, updates });
  }

  async deleteFiles(workspaceId: string, deletions: FileSyncDeletion[]): Promise<void> {
    if (this.shouldFail) throw new Error("delete failed");
    this.deleteCalls.push({ workspaceId, deletions });
  }

  async recordEvents(workspaceId: string, events: FileSyncEvent[]): Promise<void> {
    this.eventCalls.push({ workspaceId, events });
  }

  getAllSyncedPaths(): string[] {
    return this.syncCalls.flatMap((c) => c.updates.map((u) => u.path));
  }

  getAllDeletedPaths(): string[] {
    return this.deleteCalls.flatMap((c) => c.deletions.map((d) => d.path));
  }

  getAllEventPaths(): string[] {
    return this.eventCalls.flatMap((c) => c.events.map((e) => e.path));
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function createSync(
  fsOverride?: MockAgentFS,
  clientOverride?: MockConvexSyncClient,
  options?: { debounceMs?: number; maxInlineSize?: number; batchSize?: number; onSyncError?: (err: Error, paths: string[]) => void },
): { sync: ConvexFileSync; fs: MockAgentFS; client: MockConvexSyncClient } {
  const fs = fsOverride ?? new MockAgentFS();
  const client = clientOverride ?? new MockConvexSyncClient();
  const sync = new ConvexFileSync(fs, client, "ws-test", {
    debounceMs: options?.debounceMs ?? 10, // Short debounce for tests
    maxInlineSize: options?.maxInlineSize,
    batchSize: options?.batchSize,
    onSyncError: options?.onSyncError,
  });
  return { sync, fs, client };
}

// ===========================================================================
// A-TEST-1: Dirty set populated → Convex updated after flush
// ===========================================================================

test("A-TEST-1: Agent writes file → dirty set populated → Convex updated after flush", async () => {
  const { sync, fs, client } = createSync();

  await fs.writeFile("/workspace/foo.ts", "const x = 1;");

  const hooks = sync.getHooks();
  hooks.onWrite!("/workspace/foo.ts");

  sync.start();
  await sync.syncNow();

  assert.equal(client.syncCalls.length, 1);
  assert.equal(client.syncCalls[0].workspaceId, "ws-test");
  assert.equal(client.syncCalls[0].updates.length, 1);
  assert.equal(client.syncCalls[0].updates[0].path, "/workspace/foo.ts");
  assert.equal(client.syncCalls[0].updates[0].content, "const x = 1;");
  assert.equal(client.syncCalls[0].updates[0].type, "file");
  assert.equal(client.syncCalls[0].updates[0].contentAvailable, true);
  assert.equal(client.syncCalls[0].updates[0].mimeType, "text/typescript");
});

// ===========================================================================
// A-TEST-2: Multiple rapid writes → debounce triggers single batch sync
// ===========================================================================

test("A-TEST-2: Multiple rapid writes → debounce triggers single batch sync", async () => {
  const { sync, fs, client } = createSync(undefined, undefined, { debounceMs: 50 });

  await fs.writeFile("/a.ts", "a");
  await fs.writeFile("/b.ts", "b");
  await fs.writeFile("/c.ts", "c");

  const hooks = sync.getHooks();
  sync.start();

  hooks.onWrite!("/a.ts");
  hooks.onWrite!("/b.ts");
  hooks.onWrite!("/c.ts");

  // Wait for debounce to fire
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Should have been a single batch sync call
  assert.equal(client.syncCalls.length, 1);
  assert.equal(client.syncCalls[0].updates.length, 3);

  const paths = client.syncCalls[0].updates.map((u) => u.path).sort();
  assert.deepEqual(paths, ["/a.ts", "/b.ts", "/c.ts"]);
});

// ===========================================================================
// A-TEST-3: File ≤ 1MB → content stored inline
// ===========================================================================

test("A-TEST-3: File ≤ 1MB → content stored inline in Convex fileMetadata", async () => {
  const { sync, fs, client } = createSync();

  const content = "Hello, World!";
  await fs.writeFile("/small.txt", content);

  const hooks = sync.getHooks();
  hooks.onWrite!("/small.txt");
  await sync.syncNow();

  assert.equal(client.syncCalls.length, 1);
  const update = client.syncCalls[0].updates[0];
  assert.equal(update.content, content);
  assert.equal(update.contentAvailable, true);
  assert.equal(update.size, Buffer.from(content).length);
});

// ===========================================================================
// A-TEST-4: File > 1MB → metadata only, contentAvailable: false
// ===========================================================================

test("A-TEST-4: File > 1MB → metadata only in Convex, contentAvailable: false", async () => {
  const { sync, fs, client } = createSync(undefined, undefined, {
    maxInlineSize: 100, // Set low threshold for test
  });

  const bigContent = "x".repeat(200);
  await fs.writeFile("/big.bin", bigContent);

  const hooks = sync.getHooks();
  hooks.onWrite!("/big.bin");
  await sync.syncNow();

  assert.equal(client.syncCalls.length, 1);
  const update = client.syncCalls[0].updates[0];
  assert.equal(update.content, null);
  assert.equal(update.contentAvailable, false);
  assert.equal(update.size, 200);
});

// ===========================================================================
// A-TEST-5: File deleted in VM → Convex record marked as deleted
// ===========================================================================

test("A-TEST-5: File deleted in VM → Convex record marked as deleted", async () => {
  const { sync, client } = createSync();

  const hooks = sync.getHooks();
  hooks.onDelete!("/workspace/removed.ts");
  await sync.syncNow();

  assert.equal(client.deleteCalls.length, 1);
  assert.equal(client.deleteCalls[0].deletions.length, 1);
  assert.equal(client.deleteCalls[0].deletions[0].path, "/workspace/removed.ts");
});

// ===========================================================================
// A-TEST-6: File renamed → old path deleted, new path created in Convex
// ===========================================================================

test("A-TEST-6: File renamed in VM → old path deleted, new path created in Convex", async () => {
  const { sync, fs, client } = createSync();

  await fs.writeFile("/new-name.ts", "content");

  const hooks = sync.getHooks();
  hooks.onRename!("/old-name.ts", "/new-name.ts");
  await sync.syncNow();

  // Old path should be in deletions
  assert.equal(client.deleteCalls.length, 1);
  const deletedPaths = client.getAllDeletedPaths();
  assert.ok(deletedPaths.includes("/old-name.ts"));

  // New path should be in sync updates
  const syncedPaths = client.getAllSyncedPaths();
  assert.ok(syncedPaths.includes("/new-name.ts"));

  // Event should be 'renamed'
  const events = client.eventCalls.flatMap((c) => c.events);
  const renameEvent = events.find((e) => e.event === "renamed");
  assert.ok(renameEvent);
  assert.equal(renameEvent!.path, "/new-name.ts");
  assert.equal(renameEvent!.oldPath, "/old-name.ts");
});

// ===========================================================================
// A-TEST-7: Initial sync walks entire file tree
// ===========================================================================

test("A-TEST-7: Initial sync: all workspace files appear in Convex after sandbox creation", async () => {
  const fs = new MockAgentFS();
  await fs.mkdir("/src");
  await fs.writeFile("/src/main.ts", "console.log('hello')");
  await fs.writeFile("/src/util.ts", "export function util() {}");
  await fs.writeFile("/README.md", "# Hello");

  const { sync, client } = createSync(fs);

  await sync.initialSync();

  const syncedPaths = client.getAllSyncedPaths().sort();
  assert.ok(syncedPaths.includes("/src"));
  assert.ok(syncedPaths.includes("/src/main.ts"));
  assert.ok(syncedPaths.includes("/src/util.ts"));
  assert.ok(syncedPaths.includes("/README.md"));

  // Events should be created
  const eventPaths = client.getAllEventPaths().sort();
  assert.ok(eventPaths.length >= 4);
});

// ===========================================================================
// A-TEST-8: File events created for each change
// ===========================================================================

test("A-TEST-8: File events created for each change (created/modified/deleted)", async () => {
  const { sync, fs, client } = createSync();

  await fs.writeFile("/new.ts", "new");
  await fs.writeFile("/mod.ts", "modified");

  const hooks = sync.getHooks();
  hooks.onWrite!("/new.ts");
  hooks.onWrite!("/mod.ts");
  hooks.onDelete!("/old.ts");
  hooks.onMkdir!("/newdir");
  await sync.syncNow();

  const events = client.eventCalls.flatMap((c) => c.events);
  assert.ok(events.length >= 4);

  const writeEvents = events.filter((e) => e.event === "modified");
  assert.ok(writeEvents.length >= 2);

  const deleteEvent = events.find((e) => e.event === "deleted");
  assert.ok(deleteEvent);
  assert.equal(deleteEvent!.path, "/old.ts");

  const mkdirEvent = events.find((e) => e.event === "created" && e.path === "/newdir");
  assert.ok(mkdirEvent);
});

// ===========================================================================
// A-TEST-9: Sync error handling: failed file doesn't block other files
// ===========================================================================

test("A-TEST-9: Sync error handling: failed file doesn't block other files", async () => {
  const fs = new MockAgentFS();
  await fs.writeFile("/good.ts", "good");
  // /bad.ts doesn't exist — will cause ENOENT during stat

  const errorPaths: string[] = [];
  const { sync, client } = createSync(fs, undefined, {
    onSyncError: (_err, paths) => {
      errorPaths.push(...paths);
    },
  });

  const hooks = sync.getHooks();
  hooks.onWrite!("/good.ts");
  hooks.onWrite!("/bad.ts"); // This file doesn't exist
  await sync.syncNow();

  // /good.ts should have been synced
  const syncedPaths = client.getAllSyncedPaths();
  assert.ok(syncedPaths.includes("/good.ts"));

  // /bad.ts should have been moved to deletions (ENOENT → treat as deleted)
  const deletedPaths = client.getAllDeletedPaths();
  assert.ok(deletedPaths.includes("/bad.ts"));
});

// ===========================================================================
// A-TEST-10: syncNow() forces immediate flush of pending changes
// ===========================================================================

test("A-TEST-10: syncNow() forces immediate flush of pending changes", async () => {
  const { sync, fs, client } = createSync(undefined, undefined, { debounceMs: 5000 });

  await fs.writeFile("/immediate.ts", "now");

  const hooks = sync.getHooks();
  sync.start();
  hooks.onWrite!("/immediate.ts");

  // Without syncNow, debounce is 5 seconds — shouldn't have synced yet
  assert.equal(client.syncCalls.length, 0);

  // Force immediate sync
  await sync.syncNow();
  assert.equal(client.syncCalls.length, 1);
  assert.equal(client.syncCalls[0].updates[0].path, "/immediate.ts");
});

// ===========================================================================
// A-TEST-11: Clean shutdown: all pending changes flushed before sandbox close
// ===========================================================================

test("A-TEST-11: Clean shutdown: all pending changes flushed before sandbox close", async () => {
  const { sync, fs, client } = createSync(undefined, undefined, { debounceMs: 5000 });

  await fs.writeFile("/pending.ts", "flush me");

  const hooks = sync.getHooks();
  sync.start();
  hooks.onWrite!("/pending.ts");

  // stop() should flush pending changes even with long debounce
  await sync.stop();

  assert.equal(client.syncCalls.length, 1);
  assert.equal(client.syncCalls[0].updates[0].path, "/pending.ts");
  assert.equal(client.syncCalls[0].updates[0].content, "flush me");
});

// ===========================================================================
// Additional tests
// ===========================================================================

test("getStats returns correct pending count and totals", async () => {
  const { sync, fs } = createSync();

  await fs.writeFile("/a.ts", "a");
  await fs.writeFile("/b.ts", "b");

  const hooks = sync.getHooks();
  hooks.onWrite!("/a.ts");
  hooks.onWrite!("/b.ts");
  hooks.onDelete!("/c.ts");

  const stats = sync.getStats();
  assert.equal(stats.pendingFiles, 3); // 2 dirty + 1 deleted
  assert.equal(stats.totalSynced, 0);
  assert.equal(stats.totalErrors, 0);
});

test("getStats updates after sync", async () => {
  const { sync, fs, client } = createSync();

  await fs.writeFile("/a.ts", "a");
  const hooks = sync.getHooks();
  hooks.onWrite!("/a.ts");
  await sync.syncNow();

  const stats = sync.getStats();
  assert.equal(stats.pendingFiles, 0);
  assert.equal(stats.totalSynced, 1);
  assert.ok(stats.lastSyncTime > 0);
});

test("getHooks returns all four hooks", () => {
  const { sync } = createSync();
  const hooks = sync.getHooks();
  assert.ok(typeof hooks.onWrite === "function");
  assert.ok(typeof hooks.onDelete === "function");
  assert.ok(typeof hooks.onRename === "function");
  assert.ok(typeof hooks.onMkdir === "function");
});

test("mkdir hook adds directory to dirty set", async () => {
  const fs = new MockAgentFS();
  await fs.mkdir("/newdir");

  const { sync, client } = createSync(fs);

  const hooks = sync.getHooks();
  hooks.onMkdir!("/newdir");
  await sync.syncNow();

  assert.equal(client.syncCalls.length, 1);
  const update = client.syncCalls[0].updates[0];
  assert.equal(update.path, "/newdir");
  assert.equal(update.type, "directory");
  assert.equal(update.size, 0);
  assert.equal(update.content, null);
  assert.equal(update.contentAvailable, true);
});

test("initial sync skips hidden files", async () => {
  const fs = new MockAgentFS();
  await fs.writeFile("/visible.ts", "vis");
  await fs.writeFile("/.hidden", "hid");

  const { sync, client } = createSync(fs);
  await sync.initialSync();

  const syncedPaths = client.getAllSyncedPaths();
  assert.ok(syncedPaths.includes("/visible.ts"));
  assert.ok(!syncedPaths.includes("/.hidden"));
});

test("initial sync reports progress", async () => {
  const fs = new MockAgentFS();
  await fs.writeFile("/a.ts", "a");
  await fs.writeFile("/b.ts", "b");

  const progress: Array<{ synced: number; total: number }> = [];
  const client = new MockConvexSyncClient();
  const sync = new ConvexFileSync(fs, client, "ws-test", {
    debounceMs: 10,
    onProgress: (synced, total) => {
      progress.push({ synced, total });
    },
  });

  await sync.initialSync();

  assert.ok(progress.length > 0);
  const last = progress[progress.length - 1];
  assert.equal(last.synced, last.total);
});

test("debounce timer resets on additional writes", async () => {
  const { sync, fs, client } = createSync(undefined, undefined, { debounceMs: 80 });

  await fs.writeFile("/a.ts", "a");
  await fs.writeFile("/b.ts", "b");

  const hooks = sync.getHooks();
  sync.start();

  // First write
  hooks.onWrite!("/a.ts");
  await new Promise((resolve) => setTimeout(resolve, 40));

  // Second write resets timer
  hooks.onWrite!("/b.ts");
  await new Promise((resolve) => setTimeout(resolve, 40));

  // At 80ms total, first timer would have fired but was reset
  assert.equal(client.syncCalls.length, 0);

  // Wait for debounce to complete
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(client.syncCalls.length, 1);
  assert.equal(client.syncCalls[0].updates.length, 2);

  await sync.stop();
});

test("sync client error increments totalErrors", async () => {
  const fs = new MockAgentFS();
  await fs.writeFile("/fail.ts", "fail");

  const client = new MockConvexSyncClient();
  client.failOnSync = true;

  const errors: string[][] = [];
  const sync = new ConvexFileSync(fs, client, "ws-test", {
    debounceMs: 10,
    onSyncError: (_err, paths) => { errors.push(paths); },
  });

  const hooks = sync.getHooks();
  hooks.onWrite!("/fail.ts");
  await sync.syncNow();

  const stats = sync.getStats();
  assert.ok(stats.totalErrors > 0);
  assert.ok(errors.length > 0);
});

test("empty flush is a no-op", async () => {
  const { sync, client } = createSync();
  await sync.syncNow();
  assert.equal(client.syncCalls.length, 0);
  assert.equal(client.deleteCalls.length, 0);
  assert.equal(client.eventCalls.length, 0);
});

test("batch processing splits large sets", async () => {
  const fs = new MockAgentFS();
  for (let i = 0; i < 5; i++) {
    await fs.writeFile(`/file${i}.ts`, `content${i}`);
  }

  const { sync, client } = createSync(fs, undefined, { batchSize: 2 });

  const hooks = sync.getHooks();
  for (let i = 0; i < 5; i++) {
    hooks.onWrite!(`/file${i}.ts`);
  }
  await sync.syncNow();

  // With batchSize=2 and 5 files, we should get 3 syncFiles calls
  assert.equal(client.syncCalls.length, 3);
  const totalUpdates = client.syncCalls.reduce((sum, c) => sum + c.updates.length, 0);
  assert.equal(totalUpdates, 5);
});

test("MIME type detection for common extensions", async () => {
  const fs = new MockAgentFS();
  await fs.writeFile("/app.tsx", "tsx");
  await fs.writeFile("/styles.css", "css");
  await fs.writeFile("/data.json", "json");
  await fs.writeFile("/readme.md", "md");
  await fs.writeFile("/unknown.xyz", "xyz");

  const { sync, client } = createSync(fs);

  const hooks = sync.getHooks();
  hooks.onWrite!("/app.tsx");
  hooks.onWrite!("/styles.css");
  hooks.onWrite!("/data.json");
  hooks.onWrite!("/readme.md");
  hooks.onWrite!("/unknown.xyz");
  await sync.syncNow();

  const updates = client.syncCalls[0].updates;
  const byPath = new Map(updates.map((u) => [u.path, u]));

  assert.equal(byPath.get("/app.tsx")!.mimeType, "text/typescript");
  assert.equal(byPath.get("/styles.css")!.mimeType, "text/css");
  assert.equal(byPath.get("/data.json")!.mimeType, "application/json");
  assert.equal(byPath.get("/readme.md")!.mimeType, "text/markdown");
  assert.equal(byPath.get("/unknown.xyz")!.mimeType, null);
});
