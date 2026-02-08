import assert from "node:assert/strict";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  AgentToolsEdge,
  type ExecCommandRequest,
  type ReadFileRequest,
  type WriteFileRequest,
  type DeleteFileRequest,
  type ListFilesRequest,
  type SearchCodebaseRequest,
  type RunTestsRequest,
  type InstallPackageRequest,
  type ExportPatchRequest,
} from "../src/agent-tools-edge";
import type {
  AgentFSLike,
  AgentFSStatsLike,
  AgentFSFileHandleLike,
  AgentFSDirEntryLike,
} from "../src/vfs/agentfs-provider";

// ---------------------------------------------------------------------------
// Mock VM — in-memory exec stub implementing the subset used by AgentToolsEdge
// ---------------------------------------------------------------------------

class MockVM {
  execCalls: Array<{ command: string; options: any }> = [];
  nextResult = { exitCode: 0, stdout: "", stderr: "" };

  exec(command: string, options?: any) {
    this.execCalls.push({ command, options });
    const result = this.nextResult;
    const promise = Promise.resolve(result);
    return Object.assign(promise, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      write: () => {},
      end: () => {},
      resize: () => {},
      id: 1,
      result: promise,
      output: async function* () {},
      lines: async function* () {},
      [Symbol.asyncIterator]: async function* () {},
    });
  }

  async start() {}
  async close() {}
}

// ---------------------------------------------------------------------------
// Mock AgentFS — in-memory filesystem implementing AgentFSLike
// (Copied from vfs-agentfs-provider.test.ts)
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

function createEdge(
  vmOverrides?: Partial<MockVM>,
  fsOverrides?: MockAgentFS,
  options?: { defaultTimeoutMs?: number; workspacePath?: string },
): { edge: AgentToolsEdge; vm: MockVM; fs: MockAgentFS } {
  const vm = Object.assign(new MockVM(), vmOverrides ?? {});
  const fs = fsOverrides ?? new MockAgentFS();
  const edge = new AgentToolsEdge(vm as any, fs, options);
  return { edge, vm, fs };
}

// ===========================================================================
// A-TEST-1: ExecCommand — delegates to vm.exec() and returns result
// ===========================================================================

test("A-TEST-1: ExecCommand delegates command to VM and returns stdout/stderr/exitCode", async () => {
  const { edge, vm } = createEdge();
  vm.nextResult = { exitCode: 0, stdout: "hello world\n", stderr: "" };

  const resp = await edge.ExecCommand({
    command: "echo hello world",
    cwd: "/workspace",
    env: {},
    timeoutMs: 5000,
  });

  assert.equal(resp.result.exitCode, 0);
  assert.equal(resp.result.stdout, "hello world\n");
  assert.equal(resp.result.stderr, "");

  assert.equal(vm.execCalls.length, 1);
  assert.equal(vm.execCalls[0].command, "echo hello world");
  assert.equal(vm.execCalls[0].options.cwd, "/workspace");
});

test("A-TEST-1b: ExecCommand uses default workspace path when cwd is empty", async () => {
  const { edge, vm } = createEdge(undefined, undefined, { workspacePath: "/custom" });
  vm.nextResult = { exitCode: 0, stdout: "", stderr: "" };

  await edge.ExecCommand({
    command: "ls",
    cwd: "",
    env: {},
    timeoutMs: 0,
  });

  assert.equal(vm.execCalls[0].options.cwd, "/custom");
});

test("A-TEST-1c: ExecCommand passes env variables to VM", async () => {
  const { edge, vm } = createEdge();
  vm.nextResult = { exitCode: 0, stdout: "", stderr: "" };

  await edge.ExecCommand({
    command: "printenv",
    cwd: "/workspace",
    env: { FOO: "bar", BAZ: "qux", SKIP: null as any },
    timeoutMs: 5000,
  });

  const opts = vm.execCalls[0].options;
  assert.deepEqual(opts.env, { FOO: "bar", BAZ: "qux" });
});

test("A-TEST-1d: ExecCommand returns non-zero exit code from failing command", async () => {
  const { edge, vm } = createEdge();
  vm.nextResult = { exitCode: 127, stdout: "", stderr: "command not found" };

  const resp = await edge.ExecCommand({
    command: "nonexistent",
    cwd: "/workspace",
    env: {},
    timeoutMs: 5000,
  });

  assert.equal(resp.result.exitCode, 127);
  assert.equal(resp.result.stderr, "command not found");
});

// ===========================================================================
// A-TEST-2: ReadFile — reads file content via agentfs
// ===========================================================================

test("A-TEST-2: ReadFile returns file content and info", async () => {
  const { edge, fs } = createEdge();
  await fs.writeFile("/workspace/hello.txt", "Hello, World!");

  const resp = await edge.ReadFile({
    path: "/workspace/hello.txt",
    encoding: "utf8",
    offset: 0,
    length: 0,
  });

  assert.equal(resp.content, "Hello, World!");
  assert.equal(resp.info.name, "hello.txt");
  assert.equal(resp.info.path, "/workspace/hello.txt");
  assert.equal(resp.info.type, 1); // FILE_TYPE_FILE
  assert.ok(resp.info.size > 0);
});

test("A-TEST-2b: ReadFile with offset and length returns substring", async () => {
  const { edge, fs } = createEdge();
  await fs.writeFile("/workspace/data.txt", "ABCDEFGHIJ");

  const resp = await edge.ReadFile({
    path: "/workspace/data.txt",
    encoding: "utf8",
    offset: 3,
    length: 4,
  });

  assert.equal(resp.content, "DEFG");
});

test("A-TEST-2c: ReadFile throws on non-existent file", async () => {
  const { edge } = createEdge();

  await assert.rejects(
    () => edge.ReadFile({
      path: "/workspace/missing.txt",
      encoding: "utf8",
      offset: 0,
      length: 0,
    }),
    (err: NodeJS.ErrnoException) => err.code === "ENOENT",
  );
});

test("A-TEST-2d: ReadFile defaults encoding to utf8", async () => {
  const { edge, fs } = createEdge();
  await fs.writeFile("/workspace/utf.txt", "こんにちは");

  const resp = await edge.ReadFile({
    path: "/workspace/utf.txt",
    encoding: "",
    offset: 0,
    length: 0,
  });

  assert.equal(resp.content, "こんにちは");
});

// ===========================================================================
// A-TEST-3: WriteFile — writes content via agentfs, handles createDirs
// ===========================================================================

test("A-TEST-3: WriteFile creates file and returns info", async () => {
  const { edge, fs } = createEdge();
  // Ensure parent exists
  await fs.mkdir("/workspace");

  const resp = await edge.WriteFile({
    path: "/workspace/output.txt",
    content: "written content",
    encoding: "utf8",
    createDirs: false,
    mode: 0o644,
  });

  assert.equal(resp.info.name, "output.txt");
  assert.equal(resp.info.path, "/workspace/output.txt");

  // Verify content was actually written
  const data = await fs.readFile("/workspace/output.txt", "utf8");
  assert.equal(data, "written content");
});

test("A-TEST-3b: WriteFile with createDirs creates intermediate directories", async () => {
  const { edge, fs } = createEdge();

  const resp = await edge.WriteFile({
    path: "/a/b/c/deep.txt",
    content: "deep content",
    encoding: "utf8",
    createDirs: true,
    mode: 0o644,
  });

  assert.equal(resp.info.name, "deep.txt");

  // Verify intermediate dirs exist
  const statA = await fs.stat("/a");
  assert.equal(statA.isDirectory(), true);
  const statB = await fs.stat("/a/b");
  assert.equal(statB.isDirectory(), true);
  const statC = await fs.stat("/a/b/c");
  assert.equal(statC.isDirectory(), true);

  const data = await fs.readFile("/a/b/c/deep.txt", "utf8");
  assert.equal(data, "deep content");
});

// ===========================================================================
// A-TEST-4: DeleteFile — handles files and directories
// ===========================================================================

test("A-TEST-4: DeleteFile removes a file and returns deleted:true", async () => {
  const { edge, fs } = createEdge();
  await fs.writeFile("/workspace/remove-me.txt", "bye");

  const resp = await edge.DeleteFile({
    path: "/workspace/remove-me.txt",
    recursive: false,
  });

  assert.equal(resp.deleted, true);

  // Verify file is gone
  await assert.rejects(
    () => fs.stat("/workspace/remove-me.txt"),
    (err: NodeJS.ErrnoException) => err.code === "ENOENT",
  );
});

test("A-TEST-4b: DeleteFile returns deleted:false for ENOENT", async () => {
  const { edge } = createEdge();

  const resp = await edge.DeleteFile({
    path: "/workspace/does-not-exist.txt",
    recursive: false,
  });

  assert.equal(resp.deleted, false);
});

test("A-TEST-4c: DeleteFile removes empty directory", async () => {
  const { edge, fs } = createEdge();
  await fs.mkdir("/workspace");
  await fs.mkdir("/workspace/emptydir");

  const resp = await edge.DeleteFile({
    path: "/workspace/emptydir",
    recursive: false,
  });

  assert.equal(resp.deleted, true);
});

test("A-TEST-4d: DeleteFile with recursive removes directory tree via rm()", async () => {
  const { edge } = createEdge();

  // Create a MockAgentFS with rm() support
  const fs = new MockAgentFS() as MockAgentFS & { rm: (p: string, opts?: any) => Promise<void> };
  let rmCalled = false;
  let rmPath = "";
  let rmOpts: any = null;
  (fs as any).rm = async (p: string, opts?: any) => {
    rmCalled = true;
    rmPath = p;
    rmOpts = opts;
  };

  // Need to recreate edge with this fs
  const vm = new MockVM();
  const edge2 = new AgentToolsEdge(vm as any, fs as any);

  await fs.mkdir("/workspace");
  await fs.mkdir("/workspace/dir");
  await fs.writeFile("/workspace/dir/file.txt", "data");

  const resp = await edge2.DeleteFile({
    path: "/workspace/dir",
    recursive: true,
  });

  assert.equal(resp.deleted, true);
  assert.equal(rmCalled, true);
  assert.equal(rmPath, "/workspace/dir");
  assert.deepEqual(rmOpts, { recursive: true, force: true });
});

// ===========================================================================
// A-TEST-5: ListFiles — lists entries, handles recursive, filters hidden files
// ===========================================================================

test("A-TEST-5: ListFiles lists directory entries non-recursively", async () => {
  const { edge, fs } = createEdge();
  await fs.mkdir("/workspace");
  await fs.writeFile("/workspace/a.txt", "aaa");
  await fs.writeFile("/workspace/b.txt", "bbb");
  await fs.mkdir("/workspace/subdir");

  const resp = await edge.ListFiles({
    path: "/workspace",
    recursive: false,
    pattern: "",
    includeHidden: true,
  });

  assert.equal(resp.files.length, 3);
  const names = resp.files.map((f) => f.name).sort();
  assert.deepEqual(names, ["a.txt", "b.txt", "subdir"]);
});

test("A-TEST-5b: ListFiles filters hidden files when includeHidden is false", async () => {
  const { edge, fs } = createEdge();
  await fs.mkdir("/workspace");
  await fs.writeFile("/workspace/.hidden", "secret");
  await fs.writeFile("/workspace/visible.txt", "visible");

  const resp = await edge.ListFiles({
    path: "/workspace",
    recursive: false,
    pattern: "",
    includeHidden: false,
  });

  assert.equal(resp.files.length, 1);
  assert.equal(resp.files[0].name, "visible.txt");
});

test("A-TEST-5c: ListFiles recursive walks nested directories", async () => {
  const { edge, fs } = createEdge();
  await fs.mkdir("/workspace");
  await fs.writeFile("/workspace/root.txt", "r");
  await fs.mkdir("/workspace/sub");
  await fs.writeFile("/workspace/sub/nested.txt", "n");

  const resp = await edge.ListFiles({
    path: "/workspace",
    recursive: true,
    pattern: "",
    includeHidden: true,
  });

  const paths = resp.files.map((f) => f.path).sort();
  assert.ok(paths.includes("/workspace/root.txt"));
  assert.ok(paths.includes("/workspace/sub"));
  assert.ok(paths.includes("/workspace/sub/nested.txt"));
});

test("A-TEST-5d: ListFiles with pattern filters by glob", async () => {
  const { edge, fs } = createEdge();
  await fs.mkdir("/workspace");
  await fs.writeFile("/workspace/file.ts", "ts");
  await fs.writeFile("/workspace/file.js", "js");
  await fs.writeFile("/workspace/readme.md", "md");

  const resp = await edge.ListFiles({
    path: "/workspace",
    recursive: false,
    pattern: "*.ts",
    includeHidden: true,
  });

  assert.equal(resp.files.length, 1);
  assert.equal(resp.files[0].name, "file.ts");
});

// ===========================================================================
// A-TEST-6: SearchCodebase — builds rg command, parses JSON output
// ===========================================================================

test("A-TEST-6: SearchCodebase builds correct rg command and parses JSON matches", async () => {
  const { edge, vm } = createEdge();
  const rgOutput = [
    JSON.stringify({
      type: "match",
      data: {
        path: { text: "/workspace/src/main.ts" },
        line_number: 10,
        lines: { text: "const foo = 'bar';\n" },
        submatches: [{ start: 6, end: 9 }],
      },
    }),
    JSON.stringify({
      type: "match",
      data: {
        path: { text: "/workspace/src/util.ts" },
        line_number: 25,
        lines: { text: "  let foo = 42;\n" },
        submatches: [{ start: 6, end: 9 }],
      },
    }),
    "", // trailing newline
  ].join("\n");

  vm.nextResult = { exitCode: 0, stdout: rgOutput, stderr: "" };

  const resp = await edge.SearchCodebase({
    pattern: "foo",
    path: "/workspace/src",
    filePattern: "*.ts",
    caseSensitive: false,
    maxResults: 100,
    contextLines: 0,
  });

  assert.equal(resp.matches.length, 2);
  assert.equal(resp.totalMatches, 2);
  assert.equal(resp.matches[0].path, "/workspace/src/main.ts");
  assert.equal(resp.matches[0].line, 10);
  assert.equal(resp.matches[0].column, 6);
  assert.equal(resp.matches[0].text, "const foo = 'bar';");

  // Verify the rg command was built correctly
  const cmd = vm.execCalls[0].command;
  assert.ok(cmd.includes("rg"));
  assert.ok(cmd.includes("--json"));
  assert.ok(cmd.includes("-i")); // case insensitive
  assert.ok(cmd.includes("-g"));
  assert.ok(cmd.includes("*.ts"));
  assert.ok(cmd.includes("-- foo"));
  assert.ok(cmd.includes("/workspace/src"));
});

test("A-TEST-6b: SearchCodebase with caseSensitive=true omits -i flag", async () => {
  const { edge, vm } = createEdge();
  vm.nextResult = { exitCode: 1, stdout: "", stderr: "" };

  await edge.SearchCodebase({
    pattern: "Foo",
    path: "",
    filePattern: "",
    caseSensitive: true,
    maxResults: 0,
    contextLines: 0,
  });

  const cmd = vm.execCalls[0].command;
  assert.ok(!cmd.includes("-i"), "should not include -i when caseSensitive=true");
});

test("A-TEST-6c: SearchCodebase handles malformed JSON lines gracefully", async () => {
  const { edge, vm } = createEdge();
  vm.nextResult = {
    exitCode: 0,
    stdout: "not valid json\n" + JSON.stringify({
      type: "match",
      data: {
        path: { text: "/file.ts" },
        line_number: 1,
        lines: { text: "hello\n" },
        submatches: [{ start: 0, end: 5 }],
      },
    }) + "\n",
    stderr: "",
  };

  const resp = await edge.SearchCodebase({
    pattern: "hello",
    path: "",
    filePattern: "",
    caseSensitive: true,
    maxResults: 0,
    contextLines: 0,
  });

  // Should skip the malformed line and still parse the valid one
  assert.equal(resp.matches.length, 1);
  assert.equal(resp.matches[0].path, "/file.ts");
});

test("A-TEST-6d: SearchCodebase sets truncated=true when matches reach maxResults", async () => {
  const { edge, vm } = createEdge();
  const matches = Array.from({ length: 5 }, (_, i) =>
    JSON.stringify({
      type: "match",
      data: {
        path: { text: `/file${i}.ts` },
        line_number: i + 1,
        lines: { text: `line ${i}\n` },
        submatches: [{ start: 0, end: 4 }],
      },
    }),
  ).join("\n") + "\n";

  vm.nextResult = { exitCode: 0, stdout: matches, stderr: "" };

  const resp = await edge.SearchCodebase({
    pattern: "line",
    path: "",
    filePattern: "",
    caseSensitive: true,
    maxResults: 5,
    contextLines: 0,
  });

  assert.equal(resp.truncated, true);
  assert.equal(resp.totalMatches, 5);
});

// ===========================================================================
// A-TEST-7: RunTests — delegates to vm.exec with test command
// ===========================================================================

test("A-TEST-7: RunTests runs npm test and returns result", async () => {
  const { edge, vm } = createEdge();
  vm.nextResult = { exitCode: 0, stdout: "Tests passed", stderr: "" };

  const resp = await edge.RunTests({
    path: "/workspace",
    pattern: "",
    env: {},
    timeoutMs: 30000,
  });

  assert.equal(resp.result.exitCode, 0);
  assert.equal(resp.result.stdout, "Tests passed");
  assert.equal(resp.passed, 1);
  assert.equal(resp.failed, 0);

  const cmd = vm.execCalls[0].command;
  assert.ok(cmd.includes("npm test"));
  assert.ok(!cmd.includes("--"), "should not include -- when pattern is empty");
});

test("A-TEST-7b: RunTests includes pattern in command when provided", async () => {
  const { edge, vm } = createEdge();
  vm.nextResult = { exitCode: 0, stdout: "", stderr: "" };

  await edge.RunTests({
    path: "/workspace",
    pattern: "my-test-file",
    env: {},
    timeoutMs: 30000,
  });

  const cmd = vm.execCalls[0].command;
  assert.ok(cmd.includes("npm test -- my-test-file"));
});

test("A-TEST-7c: RunTests reports failure when exit code is non-zero", async () => {
  const { edge, vm } = createEdge();
  vm.nextResult = { exitCode: 1, stdout: "", stderr: "Test failed" };

  const resp = await edge.RunTests({
    path: "",
    pattern: "",
    env: {},
    timeoutMs: 10000,
  });

  assert.equal(resp.result.exitCode, 1);
  assert.equal(resp.passed, 0);
  assert.equal(resp.failed, 1);
});

// ===========================================================================
// A-TEST-8: InstallPackage — builds correct install command
// ===========================================================================

test("A-TEST-8: InstallPackage builds npm install command", async () => {
  const { edge, vm } = createEdge();
  vm.nextResult = { exitCode: 0, stdout: "added 1 package", stderr: "" };

  const resp = await edge.InstallPackage({
    packageName: "lodash",
    version: "4.17.21",
    dev: false,
    packageManager: "npm",
  });

  assert.equal(resp.result.exitCode, 0);
  assert.equal(resp.installedVersion, "4.17.21");

  const cmd = vm.execCalls[0].command;
  assert.ok(cmd.includes("npm install"));
  assert.ok(cmd.includes("lodash@4.17.21"));
  assert.ok(!cmd.includes("--save-dev"));
});

test("A-TEST-8b: InstallPackage with dev flag adds --save-dev for npm", async () => {
  const { edge, vm } = createEdge();
  vm.nextResult = { exitCode: 0, stdout: "", stderr: "" };

  await edge.InstallPackage({
    packageName: "typescript",
    version: "",
    dev: true,
    packageManager: "npm",
  });

  const cmd = vm.execCalls[0].command;
  assert.ok(cmd.includes("--save-dev"));
  assert.ok(cmd.includes("typescript"));
  assert.ok(!cmd.includes("@"), "should not include @ when version is empty");
});

test("A-TEST-8c: InstallPackage with yarn uses --dev flag", async () => {
  const { edge, vm } = createEdge();
  vm.nextResult = { exitCode: 0, stdout: "", stderr: "" };

  await edge.InstallPackage({
    packageName: "jest",
    version: "29.0.0",
    dev: true,
    packageManager: "yarn",
  });

  const cmd = vm.execCalls[0].command;
  assert.ok(cmd.startsWith("yarn install"));
  assert.ok(cmd.includes("--dev"));
  assert.ok(!cmd.includes("--save-dev"), "yarn should use --dev, not --save-dev");
  assert.ok(cmd.includes("jest@29.0.0"));
});

test("A-TEST-8d: InstallPackage defaults to npm when packageManager is empty", async () => {
  const { edge, vm } = createEdge();
  vm.nextResult = { exitCode: 0, stdout: "", stderr: "" };

  await edge.InstallPackage({
    packageName: "express",
    version: "",
    dev: false,
    packageManager: "",
  });

  const cmd = vm.execCalls[0].command;
  assert.ok(cmd.startsWith("npm install"));
});

// ===========================================================================
// A-TEST-9: ExportPatch — uses CowOverlayFS.diff() if available, falls back
// ===========================================================================

test("A-TEST-9: ExportPatch uses agentfs diff() when available", async () => {
  const fs = new MockAgentFS();
  const diffContent =
    "diff --git a/file.txt b/file.txt\n" +
    "--- a/file.txt\n" +
    "+++ b/file.txt\n" +
    "@@ -1 +1 @@\n" +
    "-old line\n" +
    "+new line\n";

  const diffFs = Object.assign(fs, {
    diff: async () => diffContent,
    listChanges: () => [{ path: "/file.txt", type: "modified" }],
  });

  const vm = new MockVM();
  const edge = new AgentToolsEdge(vm as any, diffFs);

  const resp = await edge.ExportPatch({
    basePath: "/workspace",
    paths: [],
  });

  assert.equal(resp.patch.content, diffContent);
  assert.equal(resp.patch.filesChanged, 1);
  assert.equal(resp.patch.linesAdded, 1);
  assert.equal(resp.patch.linesRemoved, 1);
  assert.equal(resp.patch.changes.length, 1);
  assert.equal(resp.patch.changes[0].path, "/file.txt");
  assert.equal(resp.patch.changes[0].type, "modified");

  // VM should not have been called since diff() was available
  assert.equal(vm.execCalls.length, 0);
});

test("A-TEST-9b: ExportPatch falls back to git diff when diff() is not available", async () => {
  const { edge, vm } = createEdge();

  const gitDiffOutput =
    "diff --git a/hello.txt b/hello.txt\n" +
    "--- a/hello.txt\n" +
    "+++ b/hello.txt\n" +
    "@@ -1,2 +1,3 @@\n" +
    "-removed line\n" +
    "+added line 1\n" +
    "+added line 2\n";

  vm.nextResult = { exitCode: 0, stdout: gitDiffOutput, stderr: "" };

  const resp = await edge.ExportPatch({
    basePath: "/workspace",
    paths: [],
  });

  assert.equal(resp.patch.content, gitDiffOutput);
  assert.equal(resp.patch.linesAdded, 2);
  assert.equal(resp.patch.linesRemoved, 1);
  assert.equal(resp.patch.filesChanged, 0); // fallback doesn't know file count
  assert.equal(resp.patch.changes.length, 0);

  // Should have called git diff in the VM
  assert.equal(vm.execCalls.length, 1);
  assert.ok(vm.execCalls[0].command.includes("git diff"));
});

test("A-TEST-9c: ExportPatch uses basePath for git diff", async () => {
  const { edge, vm } = createEdge();
  vm.nextResult = { exitCode: 0, stdout: "", stderr: "" };

  await edge.ExportPatch({
    basePath: "/custom/project",
    paths: [],
  });

  const cmd = vm.execCalls[0].command;
  assert.ok(cmd.includes("/custom/project"));
  assert.equal(vm.execCalls[0].options.cwd, "/custom/project");
});

test("A-TEST-9d: ExportPatch with diff() but no listChanges() returns empty changes array", async () => {
  const fs = new MockAgentFS();
  const diffFs = Object.assign(fs, {
    diff: async () => "+added\n-removed\n",
    // no listChanges
  });

  const vm = new MockVM();
  const edge = new AgentToolsEdge(vm as any, diffFs);

  const resp = await edge.ExportPatch({
    basePath: "/workspace",
    paths: [],
  });

  assert.equal(resp.patch.changes.length, 0);
  assert.equal(resp.patch.filesChanged, 0);
});

// ===========================================================================
// A-TEST-10: Integration — CowOverlayFS with ExportPatch
// ===========================================================================

test("A-TEST-10: ExportPatch works with CowOverlayFS integration", async () => {
  const { CowOverlayFS } = await import("../src/vfs/cow-overlay");

  const base = new MockAgentFS();
  await base.writeFile("/README.md", "original");

  const cow = new CowOverlayFS(base);
  await cow.writeFile("/README.md", "modified");
  await cow.writeFile("/new-file.txt", "new content");

  const vm = new MockVM();
  const edge = new AgentToolsEdge(vm as any, cow);

  const resp = await edge.ExportPatch({
    basePath: "/workspace",
    paths: [],
  });

  // CowOverlayFS has diff() and listChanges()
  assert.ok(resp.patch.content.length > 0);
  assert.ok(resp.patch.content.includes("+modified"));
  assert.ok(resp.patch.content.includes("+new content"));
  assert.equal(resp.patch.filesChanged, 2);

  // VM should NOT have been called
  assert.equal(vm.execCalls.length, 0);
});

// ===========================================================================
// A-TEST-11: Default options
// ===========================================================================

test("A-TEST-11: AgentToolsEdge uses default workspace /workspace and 60s timeout", async () => {
  const { edge, vm } = createEdge();
  vm.nextResult = { exitCode: 0, stdout: "", stderr: "" };

  // ExecCommand with empty cwd should use default /workspace
  await edge.ExecCommand({ command: "ls", cwd: "", env: {}, timeoutMs: 0 });
  assert.equal(vm.execCalls[0].options.cwd, "/workspace");

  // SearchCodebase with empty path should use default /workspace
  vm.nextResult = { exitCode: 0, stdout: "", stderr: "" };
  await edge.SearchCodebase({
    pattern: "test",
    path: "",
    filePattern: "",
    caseSensitive: true,
    maxResults: 0,
    contextLines: 0,
  });

  const searchCmd = vm.execCalls[1].command;
  assert.ok(searchCmd.includes("/workspace"));
});

// ===========================================================================
// A-TEST-12: SearchCodebase with contextLines
// ===========================================================================

test("A-TEST-12: SearchCodebase passes contextLines as -C flag", async () => {
  const { edge, vm } = createEdge();
  vm.nextResult = { exitCode: 0, stdout: "", stderr: "" };

  await edge.SearchCodebase({
    pattern: "function",
    path: "/workspace",
    filePattern: "",
    caseSensitive: true,
    maxResults: 50,
    contextLines: 3,
  });

  const cmd = vm.execCalls[0].command;
  assert.ok(cmd.includes("-C 3"), `expected -C 3 in command: ${cmd}`);
  assert.ok(cmd.includes("--max-count 50"));
});

// ===========================================================================
// A-TEST-13: WriteFile encoding
// ===========================================================================

test("A-TEST-13: WriteFile uses specified encoding", async () => {
  const { edge, fs } = createEdge();

  await edge.WriteFile({
    path: "/test.txt",
    content: "hello",
    encoding: "utf8",
    createDirs: true,
    mode: 0o644,
  });

  const content = await fs.readFile("/test.txt", "utf8");
  assert.equal(content, "hello");
});

// ===========================================================================
// A-TEST-14: ListFiles returns correct file types
// ===========================================================================

test("A-TEST-14: ListFiles returns correct type field for files and directories", async () => {
  const { edge, fs } = createEdge();
  await fs.mkdir("/workspace");
  await fs.writeFile("/workspace/file.txt", "data");
  await fs.mkdir("/workspace/dir");

  const resp = await edge.ListFiles({
    path: "/workspace",
    recursive: false,
    pattern: "",
    includeHidden: true,
  });

  const fileEntry = resp.files.find((f) => f.name === "file.txt");
  const dirEntry = resp.files.find((f) => f.name === "dir");

  assert.ok(fileEntry);
  assert.equal(fileEntry!.type, 1); // FILE_TYPE_FILE
  assert.ok(dirEntry);
  assert.equal(dirEntry!.type, 2); // FILE_TYPE_DIRECTORY
});

// ===========================================================================
// A-TEST-15: ExportPatch with empty diff
// ===========================================================================

test("A-TEST-15: ExportPatch returns zero counts when no changes exist", async () => {
  const { edge, vm } = createEdge();
  vm.nextResult = { exitCode: 0, stdout: "", stderr: "" };

  const resp = await edge.ExportPatch({
    basePath: "",
    paths: [],
  });

  assert.equal(resp.patch.content, "");
  assert.equal(resp.patch.linesAdded, 0);
  assert.equal(resp.patch.linesRemoved, 0);
  assert.equal(resp.patch.filesChanged, 0);
  assert.deepEqual(resp.patch.changes, []);
});
