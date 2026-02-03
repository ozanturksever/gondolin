import { WebSocket } from "ws";

import { decodeOutputFrame } from "./ws-protocol";

const WS_URL = process.env.WS_URL ?? "ws://127.0.0.1:8080";
const TOKEN = process.env.ELWING_TOKEN ?? process.env.SANDBOX_WS_TOKEN;
const REQUEST_ID = 1;
const MAX_CHUNK = 32 * 1024;

let execSent = false;
let shuttingDown = false;
let exitCode = 1;

function buildEnv() {
  const env: string[] = [];
  if (process.env.TERM) env.push(`TERM=${process.env.TERM}`);
  return env;
}

function sendExec(ws: WebSocket) {
  if (execSent) return;
  execSent = true;
  const message = {
    type: "exec",
    id: REQUEST_ID,
    cmd: "bash",
    argv: ["-i"],
    env: buildEnv(),
    stdin: true,
    pty: true,
  };
  ws.send(JSON.stringify(message));
  wireStdin(ws);
}

function wireStdin(ws: WebSocket) {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  process.stdin.on("data", (chunk: Buffer) => {
    if (shuttingDown || ws.readyState !== WebSocket.OPEN) return;
    for (let offset = 0; offset < chunk.length; offset += MAX_CHUNK) {
      const slice = chunk.subarray(offset, offset + MAX_CHUNK);
      ws.send(
        JSON.stringify({
          type: "stdin",
          id: REQUEST_ID,
          data: slice.toString("base64"),
        })
      );
    }
  });

  process.stdin.on("end", () => {
    if (shuttingDown || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: "stdin",
        id: REQUEST_ID,
        eof: true,
      })
    );
  });
}

function cleanup() {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
}

function shutdown(ws: WebSocket) {
  if (shuttingDown) return;
  shuttingDown = true;
  cleanup();
  ws.close();
  process.exit(exitCode);
}

function main() {
  const headers: Record<string, string> = {};
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

  const ws = new WebSocket(WS_URL, { headers });

  ws.on("open", () => {
    // wait for status message before sending exec
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const frame = decodeOutputFrame(Buffer.from(data as Buffer));
      if (frame.stream === "stdout") {
        process.stdout.write(frame.data);
      } else {
        process.stderr.write(frame.data);
      }
      return;
    }

    let message: { type?: string; state?: string; exit_code?: number; signal?: number; message?: string };
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (message.type === "status") {
      if (message.state === "running") {
        sendExec(ws);
      } else if (message.state === "stopped") {
        exitCode = 1;
        shutdown(ws);
      }
      return;
    }

    if (message.type === "exec_response") {
      exitCode = message.exit_code ?? 1;
      if (message.signal !== undefined) {
        process.stderr.write(`process exited due to signal ${message.signal}\n`);
      }
      shutdown(ws);
      return;
    }

    if (message.type === "error") {
      if (message.message) {
        process.stderr.write(`${message.message}\n`);
      }
      exitCode = 1;
      shutdown(ws);
    }
  });

  ws.on("error", (err) => {
    process.stderr.write(`${err.message}\n`);
    exitCode = 1;
    shutdown(ws);
  });

  ws.on("close", () => {
    if (!shuttingDown) {
      exitCode = 1;
      shutdown(ws);
    }
  });
}

main();
