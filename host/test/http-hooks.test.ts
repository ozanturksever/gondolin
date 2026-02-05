import assert from "node:assert/strict";
import test from "node:test";

import { createHttpHooks } from "../src/http-hooks";
import { HttpRequestBlockedError } from "../src/qemu-net";

test("http hooks allowlist patterns", async () => {
  const { httpHooks } = createHttpHooks({
    allowedHosts: ["example.com", "*.example.org", "api.*.net"],
  });

  const isAllowed = httpHooks.isAllowed!;

  assert.equal(
    await isAllowed({
      hostname: "example.com",
      ip: "8.8.8.8",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    true
  );

  assert.equal(
    await isAllowed({
      hostname: "Foo.Example.Org",
      ip: "1.1.1.1",
      family: 4,
      port: 80,
      protocol: "http",
    }),
    true
  );

  assert.equal(
    await isAllowed({
      hostname: "api.foo.net",
      ip: "93.184.216.34",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    true
  );

  assert.equal(
    await isAllowed({
      hostname: "nope.com",
      ip: "93.184.216.34",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    false
  );
});

test("http hooks block internal ranges by default", async () => {
  const { httpHooks } = createHttpHooks({
    allowedHosts: ["example.com"],
  });

  const isAllowed = httpHooks.isAllowed!;

  assert.equal(
    await isAllowed({
      hostname: "example.com",
      ip: "10.0.0.1",
      family: 4,
      port: 80,
      protocol: "http",
    }),
    false
  );
});

test("http hooks can allow internal ranges", async () => {
  const { httpHooks } = createHttpHooks({
    allowedHosts: ["example.com"],
    blockInternalRanges: false,
  });

  const isAllowed = httpHooks.isAllowed!;

  assert.equal(
    await isAllowed({
      hostname: "example.com",
      ip: "10.0.0.1",
      family: 4,
      port: 80,
      protocol: "http",
    }),
    true
  );
});

test("http hooks replace secret placeholders", async () => {
  const { httpHooks, env, allowedHosts } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "secret-value",
      },
    },
  });

  assert.ok(allowedHosts.includes("example.com"));

  const request = await httpHooks.onRequest!({
    method: "GET",
    url: "https://example.com/data",
    headers: {
      authorization: `Bearer ${env.API_KEY}`,
    },
    body: null,
  });

  assert.equal(request.headers.authorization, "Bearer secret-value");
});

test("http hooks reject secrets on disallowed hosts", async () => {
  const { httpHooks, env } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "secret-value",
      },
    },
  });

  await assert.rejects(
    () =>
      httpHooks.onRequest!({
        method: "GET",
        url: "https://example.org/data",
        headers: {
          authorization: `Bearer ${env.API_KEY}`,
        },
        body: null,
      }),
    (err) => err instanceof HttpRequestBlockedError
  );
});

test("http hooks pass request through custom handler", async () => {
  const seenAuth: string[] = [];

  const { httpHooks, env } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "secret-value",
      },
    },
    onRequest: (req) => {
      seenAuth.push(req.headers.authorization ?? "");
      req.headers["x-extra"] = "1";
      return req;
    },
  });

  const request = await httpHooks.onRequest!({
    method: "POST",
    url: "https://example.com/data",
    headers: {
      authorization: `Bearer ${env.API_KEY}`,
    },
    body: null,
  });

  assert.deepEqual(seenAuth, ["Bearer secret-value"]);
  assert.equal(request.headers.authorization, "Bearer secret-value");
  assert.equal(request.headers["x-extra"], "1");
});

test("http hooks preserve request when handler returns void", async () => {
  const seenAuth: string[] = [];

  const { httpHooks, env } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "secret-value",
      },
    },
    onRequest: (req) => {
      seenAuth.push(req.headers.authorization ?? "");
    },
  });

  const request = await httpHooks.onRequest!({
    method: "POST",
    url: "https://example.com/data",
    headers: {
      authorization: `Bearer ${env.API_KEY}`,
    },
    body: null,
  });

  assert.deepEqual(seenAuth, ["Bearer secret-value"]);
  assert.equal(request.headers.authorization, "Bearer secret-value");
});
