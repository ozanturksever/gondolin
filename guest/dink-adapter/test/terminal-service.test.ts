import assert from "node:assert/strict";
import test from "node:test";

import { TerminalServiceImpl } from "../src/terminal-service.js";
import type {
  IPty,
  IDisposable,
  PtySpawnFn,
  StreamOutputResponse,
  StreamSender,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Mock PTY
// ---------------------------------------------------------------------------

class MockPty implements IPty {
  pid = 1234;
  killed = false;
  lastResize: { cols: number; rows: number } | null = null;
  written: string[] = [];

  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(e: { exitCode: number }) => void> = [];

  onData(cb: (data: string) => void): IDisposable {
    this.dataListeners.push(cb);
    return {
      dispose: () => {
        this.dataListeners = this.dataListeners.filter((l) => l !== cb);
      },
    };
  }

  onExit(cb: (e: { exitCode: number }) => void): IDisposable {
    this.exitListeners.push(cb);
    return {
      dispose: () => {
        this.exitListeners = this.exitListeners.filter((l) => l !== cb);
      },
    };
  }

  write(data: string): void {
    this.written.push(data);
  }

  resize(cols: number, rows: number): void {
    this.lastResize = { cols, rows };
  }

  kill(): void {
    this.killed = true;
    for (const cb of this.exitListeners) cb({ exitCode: 0 });
  }

  emitData(data: string): void {
    for (const cb of this.dataListeners) cb(data);
  }

  emitExit(exitCode: number): void {
    for (const cb of this.exitListeners) cb({ exitCode });
  }
}

function createMockSpawn(): {
  spawnFn: PtySpawnFn;
  ptys: MockPty[];
  lastArgs: { file: string; args: string[]; options: Record<string, unknown> } | null;
} {
  const ptys: MockPty[] = [];
  let lastArgs: { file: string; args: string[]; options: Record<string, unknown> } | null = null;

  const spawnFn: PtySpawnFn = (file, args, options) => {
    lastArgs = { file, args, options };
    const pty = new MockPty();
    ptys.push(pty);
    return pty;
  };

  return { spawnFn, ptys, get lastArgs() { return lastArgs; } };
}

function collectSender(): {
  sender: StreamSender<StreamOutputResponse>;
  chunks: StreamOutputResponse[];
} {
  const chunks: StreamOutputResponse[] = [];
  const sender: StreamSender<StreamOutputResponse> = {
    async send(msg) {
      chunks.push(msg);
    },
  };
  return { sender, chunks };
}

// ---------------------------------------------------------------------------
// A-TEST-8: Open spawns PTY and returns streamId
// ---------------------------------------------------------------------------

test("Open spawns PTY and returns streamId", async () => {
  const mock = createMockSpawn();
  const svc = new TerminalServiceImpl(mock.spawnFn);

  const resp = await svc.Open({
    cols: 120,
    rows: 40,
    shell: "/bin/zsh",
    cwd: "/home",
    env: { FOO: "bar" },
  });

  assert.ok(resp.streamId);
  assert.equal(typeof resp.streamId, "string");
  assert.equal(mock.ptys.length, 1);
  assert.equal(mock.lastArgs!.file, "/bin/zsh");
  assert.equal((mock.lastArgs!.options as { cols: number }).cols, 120);
  assert.equal((mock.lastArgs!.options as { rows: number }).rows, 40);
  assert.equal((mock.lastArgs!.options as { cwd: string }).cwd, "/home");
});

test("Open defaults shell to /bin/bash", async () => {
  const mock = createMockSpawn();
  const svc = new TerminalServiceImpl(mock.spawnFn);

  await svc.Open({ cols: 80, rows: 24, shell: "", cwd: "", env: {} });

  assert.equal(mock.lastArgs!.file, "/bin/bash");
});

// ---------------------------------------------------------------------------
// A-TEST-9: Input writes data to PTY
// ---------------------------------------------------------------------------

test("Input writes data to PTY stdin", async () => {
  const { spawnFn, ptys } = createMockSpawn();
  const svc = new TerminalServiceImpl(spawnFn);

  const { streamId } = await svc.Open({
    cols: 80,
    rows: 24,
    shell: "",
    cwd: "",
    env: {},
  });

  await svc.Input({
    streamId,
    data: new TextEncoder().encode("ls\n"),
  });

  assert.equal(ptys[0].written.length, 1);
  assert.equal(ptys[0].written[0], "ls\n");
});

test("Input on missing streamId throws", async () => {
  const { spawnFn } = createMockSpawn();
  const svc = new TerminalServiceImpl(spawnFn);

  await assert.rejects(
    () => svc.Input({ streamId: "nonexistent", data: new Uint8Array() }),
    /PTY session not found/,
  );
});

// ---------------------------------------------------------------------------
// A-TEST-10: Resize changes PTY dimensions
// ---------------------------------------------------------------------------

test("Resize updates PTY dimensions", async () => {
  const { spawnFn, ptys } = createMockSpawn();
  const svc = new TerminalServiceImpl(spawnFn);

  const { streamId } = await svc.Open({
    cols: 80,
    rows: 24,
    shell: "",
    cwd: "",
    env: {},
  });

  await svc.Resize({ streamId, cols: 200, rows: 50 });

  assert.deepEqual(ptys[0].lastResize, { cols: 200, rows: 50 });
});

// ---------------------------------------------------------------------------
// StreamOutput receives PTY data and completes on exit
// ---------------------------------------------------------------------------

test("StreamOutput streams PTY data and completes on exit", async () => {
  const { spawnFn, ptys } = createMockSpawn();
  const svc = new TerminalServiceImpl(spawnFn);

  const { streamId } = await svc.Open({
    cols: 80,
    rows: 24,
    shell: "",
    cwd: "",
    env: {},
  });

  const { sender, chunks } = collectSender();

  const streamPromise = svc.StreamOutput({ streamId }, sender);

  // Emit some data, then exit
  ptys[0].emitData("file1.txt  file2.txt\n");
  ptys[0].emitData("$ ");

  // Small delay to let async sends complete
  await new Promise((r) => setTimeout(r, 10));

  ptys[0].emitExit(0);
  await streamPromise;

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].streamId, streamId);
  assert.equal(
    new TextDecoder().decode(chunks[0].data),
    "file1.txt  file2.txt\n",
  );
  assert.equal(new TextDecoder().decode(chunks[1].data), "$ ");
});

// ---------------------------------------------------------------------------
// Max PTY sessions enforced
// ---------------------------------------------------------------------------

test("max 5 concurrent PTY sessions", async () => {
  const { spawnFn } = createMockSpawn();
  const svc = new TerminalServiceImpl(spawnFn);

  const openReq = { cols: 80, rows: 24, shell: "", cwd: "", env: {} };

  for (let i = 0; i < 5; i++) {
    await svc.Open(openReq);
  }

  await assert.rejects(() => svc.Open(openReq), /max PTY sessions/);
});

// ---------------------------------------------------------------------------
// A-TEST-11: Shutdown kills all sessions
// ---------------------------------------------------------------------------

test("shutdown kills all PTY sessions", async () => {
  const { spawnFn, ptys } = createMockSpawn();
  const svc = new TerminalServiceImpl(spawnFn);

  const openReq = { cols: 80, rows: 24, shell: "", cwd: "", env: {} };
  await svc.Open(openReq);
  await svc.Open(openReq);

  assert.equal(svc.sessionCount, 2);

  svc.shutdown();

  assert.equal(svc.sessionCount, 0);
  assert.ok(ptys.every((p) => p.killed));
});

// ---------------------------------------------------------------------------
// PTY exit cleans up session from map
// ---------------------------------------------------------------------------

test("PTY exit removes session from map", async () => {
  const { spawnFn, ptys } = createMockSpawn();
  const svc = new TerminalServiceImpl(spawnFn);

  const { streamId } = await svc.Open({
    cols: 80,
    rows: 24,
    shell: "",
    cwd: "",
    env: {},
  });

  assert.equal(svc.sessionCount, 1);

  ptys[0].emitExit(0);

  assert.equal(svc.sessionCount, 0);

  await assert.rejects(
    () => svc.Input({ streamId, data: new Uint8Array() }),
    /PTY session not found/,
  );
});
