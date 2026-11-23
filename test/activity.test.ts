// Notes-repo activity without the network: the Accounts path and URL, and the
// two timeouts. Synthetic names only: "Acme", "Globex", "Initech", "demo/notes".

import assert from "node:assert/strict";
import { test } from "node:test";
import { accountPath, commitsUrl, fetchActivity } from "../src/activity.ts";
import type { FetchLike } from "../src/github.ts";
import type { Item, SentPing } from "../src/rules.ts";

function item(id: string, account: string | null): Item {
  return {
    id,
    ref: `demo#${id}`,
    title: `Work ${id}`,
    url: `https://github.com/acme/demo/issues/${id}`,
    status: "In progress",
    target: null,
    nextTouch: null,
    nextAction: null,
    waitingOn: null,
    type: null,
    stage: null,
    track: null,
    account,
    cadence: null,
    parentUrl: null,
    contentId: null,
    updatedAt: "2026-11-20T00:00:00.000Z",
  };
}

function ping(id: string, sentAt = "2026-11-25T01:00:00.000Z"): SentPing {
  return { key: `2026-11-25:M:${id}`, itemId: id, date: "2026-11-25", slot: "M", kind: "ping", sentAt, ackedAt: null };
}

/** A fetch that never answers: it only ever settles by being aborted. */
const hang = (init: RequestInit): Promise<Response> =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init.signal;
    if (!signal) throw new Error("the request carried no signal");
    signal.addEventListener("abort", () => reject(signal.reason));
  });

test("an Account with a space keeps the space, encoded, as one folder", () => {
  assert.equal(accountPath("Acme Ltd"), "Accounts/Acme%20Ltd");
  assert.equal(accountPath("Acme"), "Accounts/Acme");
});

test("the commits URL asks for one Account's folder since one instant", () => {
  const url = commitsUrl("demo/notes", "Acme Ltd", "2026-11-25T01:00:00.000Z");
  assert.equal(
    url,
    "https://api.github.com/repos/demo/notes/commits?path=Accounts/Acme%20Ltd&since=2026-11-25T01%3A00%3A00.000Z&per_page=20",
  );
});

test("a notes call that never answers is cut off, logged and ignored", async () => {
  const logs: string[] = [];
  let aborted: unknown = null;
  const fetchFn: FetchLike = (_url, init) => {
    init.signal?.addEventListener("abort", () => {
      aborted = init.signal?.reason;
    });
    return hang(init);
  };

  const activity = await fetchActivity({
    token: "test-token",
    repo: "demo/notes",
    items: [item("1", "Acme")],
    history: [ping("1")],
    log: (line) => logs.push(line),
    fetchFn,
    requestTimeoutMs: 20,
  });

  assert.deepEqual([...activity], [], "no activity beats a stuck slot");
  assert.ok(aborted instanceof Error, "the request was aborted by its own timeout");
  assert.match(logs.join("\n"), /notes activity for Acme failed, ignored/);
});

test("once the whole budget is spent no further Account is asked", async () => {
  const urls: string[] = [];
  const logs: string[] = [];
  const items = [item("1", "Acme"), item("2", "Globex"), item("3", "Initech")];

  const activity = await fetchActivity({
    token: "test-token",
    repo: "demo/notes",
    items,
    history: [ping("1"), ping("2"), ping("3")],
    log: (line) => logs.push(line),
    fetchFn: (url, init) => {
      urls.push(url);
      return hang(init);
    },
    budgetMs: 20,
  });

  assert.deepEqual([...activity], []);
  assert.equal(urls.length, 1, "the first call spent the budget");
  assert.match(logs.join("\n"), /the 20 ms budget is spent, 2 account\(s\) not checked/);
});
