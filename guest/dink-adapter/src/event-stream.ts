import type { SandboxAgent } from "./sandbox-agent.js";
import type {
  AgentEventStreamServiceServer,
  StreamEventsRequest,
  StreamEventsResponse,
  StreamSender,
  UniversalEvent,
} from "./types.js";

export class EventStreamImpl implements AgentEventStreamServiceServer {
  constructor(private readonly agent: SandboxAgent) {}

  async StreamEvents(
    req: StreamEventsRequest,
    stream: StreamSender<StreamEventsResponse>,
  ): Promise<void> {
    const ac = new AbortController();
    const path = `/v1/sessions/${encodeURIComponent(req.sessionId)}/events/sse?from_id=${req.fromId}`;

    try {
      const body = await this.agent.sseStream(path, ac.signal);
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";

        for (const block of blocks) {
          const event = parseSseBlock(block);
          if (event) {
            await stream.send({ event });
          }
        }
      }

      if (buffer.trim()) {
        const event = parseSseBlock(buffer);
        if (event) {
          await stream.send({ event });
        }
      }
    } finally {
      ac.abort();
    }
  }
}

function parseSseBlock(block: string): UniversalEvent | null {
  const lines = block.split("\n");
  let dataStr = "";

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      dataStr += line.slice(6);
    } else if (line.startsWith("data:")) {
      dataStr += line.slice(5);
    }
  }

  if (!dataStr) return null;

  try {
    const raw = JSON.parse(dataStr) as Record<string, unknown>;
    return {
      id: (raw.id as number) ?? 0,
      timestamp: raw.timestamp ? new Date(raw.timestamp as string) : new Date(),
      sessionId: (raw.sessionId as string) ?? (raw.session_id as string) ?? "",
      agent: (raw.agent as string) ?? "",
      type: (raw.type as number) ?? 0,
      data: (raw.data as Record<string, unknown>) ?? {},
    };
  } catch {
    return null;
  }
}
