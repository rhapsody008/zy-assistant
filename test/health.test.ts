// The health endpoint over a real loopback server on port 0, with the clock
// injected: no wait, no real timer, nothing outside 127.0.0.1.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Health, TICK_FRESH_MS } from "../src/health.ts";

const T0 = "2026-11-25T01:00:00.000Z";

async function serve(): Promise<{ health: Health; url: string; setNow: (iso: string) => void; close: () => Promise<void> }> {
  let now = new Date(T0);
  const health = new Health(() => now);
  const port = await health.listen(0);
  assert.ok(port > 0, "port 0 binds an ephemeral port");
  return {
    health,
    url: `http://127.0.0.1:${port}`,
    setNow: (iso) => {
      now = new Date(iso);
    },
    close: () => health.close(),
  };
}

async function get(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("before the first tick the endpoint is 503", async () => {
  const s = await serve();
  try {
    const res = await get(`${s.url}/healthz`);
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { ok: false, lastTickAt: null });
  } finally {
    await s.close();
  }
});

test("a tick just now is 200 and says when it finished", async () => {
  const s = await serve();
  try {
    s.health.record({ at: new Date(T0) });
    const res = await get(`${s.url}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, lastTickAt: T0 });
  } finally {
    await s.close();
  }
});

test("a tick from 5 minutes ago or more is 503", async () => {
  const s = await serve();
  try {
    s.health.record({ at: new Date(T0) });

    s.setNow(new Date(Date.parse(T0) + TICK_FRESH_MS - 1).toISOString());
    assert.equal((await get(`${s.url}/healthz`)).status, 200, "just inside the window");

    s.setNow(new Date(Date.parse(T0) + TICK_FRESH_MS).toISOString());
    const stale = await get(`${s.url}/healthz`);
    assert.equal(stale.status, 503, "exactly at the window is stale");
    assert.deepEqual(stale.body, { ok: false, lastTickAt: T0 });
  } finally {
    await s.close();
  }
});

test("a newer tick replaces the older one", async () => {
  const s = await serve();
  try {
    s.health.record({ at: new Date(T0) });
    s.health.record({ at: new Date("2026-11-25T02:00:00.000Z") });
    const res = await get(`${s.url}/healthz`);
    assert.deepEqual(res.body, { ok: true, lastTickAt: "2026-11-25T02:00:00.000Z" });
  } finally {
    await s.close();
  }
});

test("anything but GET /healthz is 404", async () => {
  const s = await serve();
  try {
    s.health.record({ at: new Date(T0) });
    for (const path of ["/", "/health", "/livez"]) assert.equal((await get(`${s.url}${path}`)).status, 404, path);

    const posted = await fetch(`${s.url}/healthz`, { method: "POST", signal: AbortSignal.timeout(2000) });
    assert.equal(posted.status, 404);
  } finally {
    await s.close();
  }
});

test("close is idempotent, and a closed server no longer answers", async () => {
  const s = await serve();
  await s.close();
  await s.close();
  await assert.rejects(get(`${s.url}/healthz`));
});
