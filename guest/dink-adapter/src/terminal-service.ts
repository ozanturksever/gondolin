import { randomUUID } from "node:crypto";
import type {
  TerminalServiceServer,
  OpenRequest,
  OpenResponse,
  InputRequest,
  InputResponse,
  ResizeRequest,
  ResizeResponse,
  StreamOutputRequest,
  StreamOutputResponse,
  StreamSender,
  IPty,
  PtySpawnFn,
} from "./types.js";

const MAX_PTY_SESSIONS = 5;

export class TerminalServiceImpl implements TerminalServiceServer {
  private readonly sessions = new Map<string, IPty>();

  constructor(private readonly spawnPty: PtySpawnFn) {}

  async Open(req: OpenRequest): Promise<OpenResponse> {
    if (this.sessions.size >= MAX_PTY_SESSIONS) {
      throw new Error(`max PTY sessions reached (${MAX_PTY_SESSIONS})`);
    }

    const shell = req.shell || "/bin/bash";
    const cwd = req.cwd || "/workspace";
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.env ?? {})) {
      if (typeof v === "string") env[k] = v;
    }
    env.TERM ??= "xterm-256color";

    const pty = this.spawnPty(shell, [], {
      cols: req.cols || 80,
      rows: req.rows || 24,
      cwd,
      env,
    });

    const streamId = randomUUID();
    this.sessions.set(streamId, pty);

    pty.onExit(() => {
      this.sessions.delete(streamId);
    });

    return { streamId };
  }

  async Input(req: InputRequest): Promise<InputResponse> {
    const pty = this.sessions.get(req.streamId);
    if (!pty) throw new Error(`PTY session not found: ${req.streamId}`);
    const text =
      req.data instanceof Uint8Array
        ? new TextDecoder().decode(req.data)
        : String(req.data);
    pty.write(text);
    return {};
  }

  async Resize(req: ResizeRequest): Promise<ResizeResponse> {
    const pty = this.sessions.get(req.streamId);
    if (!pty) throw new Error(`PTY session not found: ${req.streamId}`);
    pty.resize(req.cols, req.rows);
    return {};
  }

  async StreamOutput(
    req: StreamOutputRequest,
    stream: StreamSender<StreamOutputResponse>,
  ): Promise<void> {
    const pty = this.sessions.get(req.streamId);
    if (!pty) throw new Error(`PTY session not found: ${req.streamId}`);

    const encoder = new TextEncoder();

    await new Promise<void>((resolve) => {
      const dataSub = pty.onData((data: string) => {
        stream
          .send({
            streamId: req.streamId,
            data: encoder.encode(data),
            timestamp: new Date(),
          })
          .catch(() => {});
      });

      const exitSub = pty.onExit(() => {
        dataSub.dispose();
        exitSub.dispose();
        resolve();
      });
    });
  }

  shutdown(): void {
    for (const [id, pty] of this.sessions) {
      try {
        pty.kill();
      } catch {
        // best effort
      }
      this.sessions.delete(id);
    }
  }

  get sessionCount(): number {
    return this.sessions.size;
  }
}
