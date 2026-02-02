import net from "net";
import cbor from "cbor";

const MAX_FRAME = 4 * 1024 * 1024;

type ExecOutput = {
  v: number;
  t: "exec_output";
  id: number;
  p: {
    stream: "stdout" | "stderr";
    data: Buffer;
  };
};

type ExecResponse = {
  v: number;
  t: "exec_response";
  id: number;
  p: {
    exit_code: number;
    signal?: number;
  };
};

type ErrorResponse = {
  v: number;
  t: "error";
  id: number;
  p: {
    code: string;
    message: string;
  };
};

type IncomingMessage = ExecOutput | ExecResponse | ErrorResponse;

type Command = {
  cmd: string;
  argv: string[];
  env: string[];
  cwd?: string;
  id: number;
};

type Args = {
  sock?: string;
  commands: Command[];
};

function parseArgs(argv: string[]): Args {
  const args: Args = { commands: [] };
  let current: Command | null = null;
  let nextId = 1;

  const fail = (message: string): never => {
    console.error(message);
    usage();
    process.exit(1);
  };

  const parseId = (value: string) => {
    const id = Number(value);
    if (!Number.isFinite(id)) fail("--id must be a number");
    if (id >= nextId) nextId = id + 1;
    return id;
  };

  const separatorIndex = argv.indexOf("--");
  if (separatorIndex !== -1) {
    const optionArgs = argv.slice(0, separatorIndex);
    const commandArgs = argv.slice(separatorIndex + 1);
    if (commandArgs.length === 0) fail("missing command after --");

    current = {
      cmd: commandArgs[0],
      argv: commandArgs.slice(1),
      env: [],
      id: nextId++,
    };
    args.commands.push(current);

    for (let i = 0; i < optionArgs.length; i += 1) {
      const arg = optionArgs[i];
      switch (arg) {
        case "--sock":
          args.sock = optionArgs[++i];
          break;
        case "--env":
          current.env.push(optionArgs[++i]);
          break;
        case "--cwd":
          current.cwd = optionArgs[++i];
          break;
        case "--id":
          current.id = parseId(optionArgs[++i]);
          break;
        case "--help":
        case "-h":
          usage();
          process.exit(0);
        default:
          fail(`Unknown argument: ${arg}`);
      }
    }

    return args;
  }

  const requireCurrent = (flag: string): Command => {
    if (!current) fail(`${flag} requires --cmd`);
    return current!;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--sock":
        args.sock = argv[++i];
        break;
      case "--cmd":
        current = { cmd: argv[++i], argv: [], env: [], id: nextId++ };
        args.commands.push(current);
        break;
      case "--arg": {
        const command = requireCurrent("--arg");
        command.argv.push(argv[++i]);
        break;
      }
      case "--env": {
        const command = requireCurrent("--env");
        command.env.push(argv[++i]);
        break;
      }
      case "--cwd": {
        const command = requireCurrent("--cwd");
        command.cwd = argv[++i];
        break;
      }
      case "--id": {
        const command = requireCurrent("--id");
        command.id = parseId(argv[++i]);
        break;
      }
      case "--help":
      case "-h":
        usage();
        process.exit(0);
      default:
        fail(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  console.log("Usage:");
  console.log("  node dist/exec.js --sock PATH -- CMD [ARGS...]");
  console.log(
    "  node dist/exec.js --sock PATH --cmd CMD [--arg ARG] [--env KEY=VALUE] [--cwd PATH] [--cmd CMD ...]"
  );
  console.log("Use -- to pass a command and its arguments directly.");
  console.log("Arguments apply to the most recent --cmd.");
}

class FrameReader {
  private buffer = Buffer.alloc(0);
  private expectedLength: number | null = null;

  push(chunk: Buffer, onFrame: (frame: Buffer) => void) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      if (this.expectedLength === null) {
        if (this.buffer.length < 4) return;
        this.expectedLength = this.buffer.readUInt32BE(0);
        this.buffer = this.buffer.slice(4);
        if (this.expectedLength > MAX_FRAME) {
          throw new Error(`Frame too large: ${this.expectedLength}`);
        }
      }

      if (this.buffer.length < this.expectedLength) return;

      const frame = this.buffer.slice(0, this.expectedLength);
      this.buffer = this.buffer.slice(this.expectedLength);
      this.expectedLength = null;
      onFrame(frame);
    }
  }
}

function normalize(value: unknown): unknown {
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [key, entry] of value.entries()) {
      obj[String(key)] = normalize(entry);
    }
    return obj;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalize(entry));
  }
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  return value;
}

function buildExecRequest(command: Command) {
  const payload: Record<string, unknown> = {
    cmd: command.cmd,
  };

  if (command.argv.length > 0) payload.argv = command.argv;
  if (command.env.length > 0) payload.env = command.env;
  if (command.cwd) payload.cwd = command.cwd;

  return {
    v: 1,
    t: "exec_request",
    id: command.id,
    p: payload,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sock || args.commands.length === 0) {
    usage();
    process.exit(1);
  }

  const socket = net.createConnection({ path: args.sock });
  const reader = new FrameReader();
  let currentIndex = 0;
  let inflightId: number | null = null;
  let exitCode = 0;
  let closing = false;

  const sendNext = () => {
    const command = args.commands[currentIndex];
    inflightId = command.id;
    const message = buildExecRequest(command);
    const payload = cbor.encode(message);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    socket.write(Buffer.concat([header, payload]));
  };

  const finish = (code?: number) => {
    if (code !== undefined && exitCode === 0) exitCode = code;
    if (closing) return;
    closing = true;
    socket.end();
  };

  socket.on("connect", () => {
    console.log(`connected to ${args.sock}`);
    sendNext();
  });

  socket.on("data", (chunk) => {
    reader.push(chunk, (frame) => {
      const raw = cbor.decodeFirstSync(frame);
      const message = normalize(raw) as IncomingMessage;
      if (message.t === "exec_output") {
        const data = Buffer.isBuffer(message.p.data)
          ? message.p.data
          : Buffer.from(message.p.data as unknown as Uint8Array);
        if (message.p.stream === "stdout") {
          process.stdout.write(data);
        } else {
          process.stderr.write(data);
        }
      } else if (message.t === "exec_response") {
        if (inflightId !== null && message.id !== inflightId) {
          console.error(`unexpected response id ${message.id} (expected ${inflightId})`);
          finish(1);
          return;
        }
        const code = message.p.exit_code ?? 1;
        const signal = message.p.signal;
        if (signal !== undefined) {
          console.error(`process exited due to signal ${signal}`);
        }
        if (code !== 0 && exitCode === 0) exitCode = code;
        currentIndex += 1;
        if (currentIndex < args.commands.length) {
          sendNext();
        } else {
          finish();
        }
      } else if (message.t === "error") {
        console.error(`error ${message.p.code}: ${message.p.message}`);
        finish(1);
      }
    });
  });

  socket.on("error", (err) => {
    console.error(`socket error: ${err.message}`);
    finish(1);
  });

  socket.on("end", () => {
    if (!closing && exitCode === 0) exitCode = 1;
  });

  socket.on("close", () => {
    process.exit(exitCode);
  });
}

main();
