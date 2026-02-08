import assert from "node:assert/strict";
import test from "node:test";

import { EventStreamImpl } from "../src/event-stream.js";
import type { SandboxAgent } from "../src/sandbox-agent.js";
import type { StreamEventsResponse, StreamSender } from "../src/types.js";
import { EventType } from "../src/types.js";

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sseBlock(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function createSseStream(blocks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = blocks.join("");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

function createMockAgent(stream: ReadableStream<Uint8Array>): SandboxAgent {
  return {
    async post() {
      throw new Error("not used");
    },
    async get() {
      throw new Error("not used");
    },
    async sseStream() {
      return stream;
    },
  };
}

function collectSender(): {
  sender: StreamSender<StreamEventsResponse>;
  events: StreamEventsResponse[];
} {
  const events: StreamEventsResponse[] = [];
  const sender: StreamSender<StreamEventsResponse> = {
    async send(msg) {
      events.push(msg);
    },
  };
  return { sender, events };
}

// ---------------------------------------------------------------------------
// A-TEST-7: StreamEvents receives and parses SSE events
// ---------------------------------------------------------------------------

test("StreamEvents parses SSE events from sandbox-agent", async () => {
  const blocks = [
    sseBlock({
      id: 1,
      timestamp: "2024-01-01T00:00:00Z",
      sessionId: "s1",
      agent: "claude",
      type: EventType.EVENT_TYPE_SESSION_STARTED,
      data: { message: "started" },
    }),
    sseBlock({
      id: 2,
      timestamp: "2024-01-01T00:00:01Z",
      sessionId: "s1",
      agent: "claude",
      type: EventType.EVENT_TYPE_ITEM,
      data: { content: "hello" },
    }),
  ];

  const agent = createMockAgent(createSseStream(blocks));
  const svc = new EventStreamImpl(agent);
  const { sender, events } = collectSender();

  await svc.StreamEvents({ sessionId: "s1", fromId: 0 }, sender);

  assert.equal(events.length, 2);
  assert.equal(events[0].event.id, 1);
  assert.equal(events[0].event.type, EventType.EVENT_TYPE_SESSION_STARTED);
  assert.equal(events[0].event.sessionId, "s1");
  assert.equal(events[1].event.id, 2);
  assert.equal(events[1].event.type, EventType.EVENT_TYPE_ITEM);
  assert.deepEqual(events[1].event.data, { content: "hello" });
});

// ---------------------------------------------------------------------------
// Handles chunked delivery (event split across chunks)
// ---------------------------------------------------------------------------

test("StreamEvents handles chunked SSE delivery", async () => {
  const encoder = new TextEncoder();
  const fullPayload = sseBlock({
    id: 1,
    sessionId: "s1",
    agent: "claude",
    type: EventType.EVENT_TYPE_ITEM,
    data: { text: "chunked" },
  });

  const mid = Math.floor(fullPayload.length / 2);
  const chunk1 = fullPayload.slice(0, mid);
  const chunk2 = fullPayload.slice(mid);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(chunk1));
      controller.enqueue(encoder.encode(chunk2));
      controller.close();
    },
  });

  const agent = createMockAgent(stream);
  const svc = new EventStreamImpl(agent);
  const { sender, events } = collectSender();

  await svc.StreamEvents({ sessionId: "s1", fromId: 0 }, sender);

  assert.equal(events.length, 1);
  assert.equal(events[0].event.id, 1);
  assert.deepEqual(events[0].event.data, { text: "chunked" });
});

// ---------------------------------------------------------------------------
// Ignores malformed SSE lines
// ---------------------------------------------------------------------------

test("StreamEvents ignores malformed SSE blocks", async () => {
  const encoder = new TextEncoder();
  const payload =
    "event: heartbeat\n\n" +
    sseBlock({ id: 1, sessionId: "s1", agent: "claude", type: 3, data: {} }) +
    "data: {invalid-json\n\n" +
    sseBlock({ id: 2, sessionId: "s1", agent: "claude", type: 4, data: {} });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });

  const agent = createMockAgent(stream);
  const svc = new EventStreamImpl(agent);
  const { sender, events } = collectSender();

  await svc.StreamEvents({ sessionId: "s1", fromId: 0 }, sender);

  assert.equal(events.length, 2);
  assert.equal(events[0].event.id, 1);
  assert.equal(events[1].event.id, 2);
});

// ---------------------------------------------------------------------------
// Empty stream produces no events
// ---------------------------------------------------------------------------

test("StreamEvents handles empty stream", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

  const agent = createMockAgent(stream);
  const svc = new EventStreamImpl(agent);
  const { sender, events } = collectSender();

  await svc.StreamEvents({ sessionId: "s1", fromId: 0 }, sender);

  assert.equal(events.length, 0);
});
