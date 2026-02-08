import http from "node:http";

import type { VM } from "./vm";
import type { ExecProcess } from "./exec";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebSocketProxyOptions {
  port?: number;
  host?: string;
}

export interface TerminalSession {
  id: string;
  workspaceId: string;
  process: ExecProcess;
  createdAt: Date;
}

interface WebSocketLike {
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  readyState: number;
}

// ---------------------------------------------------------------------------
// WebSocket Terminal Proxy
// ---------------------------------------------------------------------------

export class WebSocketTerminalProxy {
  private readonly sessions = new Map<string, TerminalSession>();
  private server: http.Server | null = null;
  private wss: { close(): void } | null = null;
  private vmLookup: (workspaceId: string) => VM | undefined;

  constructor(vmLookup: (workspaceId: string) => VM | undefined) {
    this.vmLookup = vmLookup;
  }

  async start(options: WebSocketProxyOptions = {}): Promise<{ port: number; host: string }> {
    const port = options.port ?? 0;
    const host = options.host ?? "127.0.0.1";

    // Lazy import ws to avoid hard dependency
    let WebSocketServer: new (opts: { server: http.Server; path?: string }) => {
      on(event: string, handler: (...args: unknown[]) => void): void;
      close(): void;
    };
    try {
      const ws = await import("ws");
      WebSocketServer = ws.WebSocketServer ?? (ws.default as { WebSocketServer: typeof WebSocketServer }).WebSocketServer;
    } catch {
      throw new Error("ws package is required for WebSocket terminal proxy. Install with: npm install ws");
    }

    this.server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end("WebSocket only");
    });

    const wss = new WebSocketServer({ server: this.server });
    this.wss = wss;

    wss.on("connection", (ws: WebSocketLike, req: http.IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    return new Promise((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => {
        this.server!.off("error", reject);
        const addr = this.server!.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("unexpected server address"));
          return;
        }
        resolve({ port: addr.port, host });
      });
    });
  }

  async close(): Promise<void> {
    // Kill all active sessions
    for (const session of this.sessions.values()) {
      try {
        session.process.end();
      } catch {
        // ignore
      }
    }
    this.sessions.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }

  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  get activeSessions(): number {
    return this.sessions.size;
  }

  private handleConnection(ws: WebSocketLike, req: http.IncomingMessage) {
    // Extract workspaceId from URL path: /workspace/:id/terminal
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathMatch = url.pathname.match(/^\/workspace\/([^/]+)\/terminal$/);

    if (!pathMatch) {
      ws.close(4000, "Invalid path. Use /workspace/:id/terminal");
      return;
    }

    const workspaceId = pathMatch[1];
    const vm = this.vmLookup(workspaceId);

    if (!vm) {
      ws.close(4001, `No VM found for workspace ${workspaceId}`);
      return;
    }

    // Parse initial cols/rows from query params
    const cols = parseInt(url.searchParams.get("cols") ?? "80", 10);
    const rows = parseInt(url.searchParams.get("rows") ?? "24", 10);

    // Spawn shell process
    const proc = vm.exec(["/bin/bash", "-i"], {
      stdin: true,
      pty: true,
    });

    // Resize to initial dimensions
    proc.resize(rows, cols);

    const sessionId = `${workspaceId}-${Date.now()}`;
    const session: TerminalSession = {
      id: sessionId,
      workspaceId,
      process: proc,
      createdAt: new Date(),
    };
    this.sessions.set(sessionId, session);

    // Forward VM stdout → WebSocket
    proc.stdout.on("data", (chunk: Buffer) => {
      if (ws.readyState === 1) {
        ws.send(chunk);
      }
    });

    // Forward VM stderr → WebSocket
    proc.stderr.on("data", (chunk: Buffer) => {
      if (ws.readyState === 1) {
        ws.send(chunk);
      }
    });

    // Handle WebSocket messages → VM stdin
    ws.on("message", (data: Buffer | string) => {
      if (typeof data === "string") {
        try {
          const msg = JSON.parse(data);
          if (msg.type === "resize" && msg.cols && msg.rows) {
            proc.resize(msg.rows, msg.cols);
            return;
          }
          if (msg.type === "input" && msg.data) {
            proc.write(msg.data);
            return;
          }
        } catch {
          // Not JSON, treat as raw input
        }
        proc.write(data);
      } else {
        proc.write(data as Buffer);
      }
    });

    // Handle WebSocket close
    ws.on("close", () => {
      this.sessions.delete(sessionId);
      try {
        proc.end();
      } catch {
        // ignore
      }
    });

    // Handle process exit
    proc.then(() => {
      this.sessions.delete(sessionId);
      if (ws.readyState === 1) {
        ws.close(1000, "Process exited");
      }
    }).catch(() => {
      this.sessions.delete(sessionId);
      if (ws.readyState === 1) {
        ws.close(1011, "Process error");
      }
    });

    // Handle WebSocket errors
    ws.on("error", () => {
      this.sessions.delete(sessionId);
      try {
        proc.end();
      } catch {
        // ignore
      }
    });
  }
}
