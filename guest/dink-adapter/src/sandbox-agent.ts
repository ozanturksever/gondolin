export interface SandboxAgent {
  post<T>(path: string, body?: unknown): Promise<T>;
  get<T>(path: string): Promise<T>;
  sseStream(path: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

export class SandboxAgentHttp implements SandboxAgent {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof globalThis.fetch,
  ) {}

  async post<T>(path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw Object.assign(
        new Error(`sandbox-agent POST ${path}: ${res.status} ${text}`),
        { status: res.status },
      );
    }
    return res.json() as Promise<T>;
  }

  async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetchImpl(url, {
      method: "GET",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw Object.assign(
        new Error(`sandbox-agent GET ${path}: ${res.status} ${text}`),
        { status: res.status },
      );
    }
    return res.json() as Promise<T>;
  }

  async sseStream(path: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw Object.assign(
        new Error(`sandbox-agent SSE ${path}: ${res.status} ${text}`),
        { status: res.status },
      );
    }
    if (!res.body) {
      throw new Error(`sandbox-agent SSE ${path}: no response body`);
    }
    return res.body;
  }
}

export async function waitForHealth(
  baseUrl: string,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const interval = 500;
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(`${baseUrl}/v1/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`sandbox-agent at ${baseUrl} did not become healthy within ${timeoutMs}ms`);
}
