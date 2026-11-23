// The notes repo without the network: the Contents URLs, the folders, the 404
// that is a null, the base64 of non-ASCII text, and a write that lost the race.
// Synthetic names only: "Acme", "Globex", "demo/notes".

import assert from "node:assert/strict";
import { test } from "node:test";
import { createNotesClient, ShaConflict } from "../src/notes.ts";
import type { FetchLike } from "../src/github.ts";

interface Call {
  url: string;
  init: RequestInit;
}

/** A fake Contents API: url -> [status, body]. */
function fakeApi(routes: Record<string, [number, unknown]>): { calls: Call[]; fetchFn: FetchLike } {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const route = routes[`${init.method ?? "GET"} ${url}`];
    if (!route) throw new Error(`the fake has no route for ${init.method} ${url}`);
    return new Response(JSON.stringify(route[1]), { status: route[0] });
  };
  return { calls, fetchFn };
}

const client = (fetchFn: FetchLike) => createNotesClient({ repo: "demo/notes", token: "gh-1", fetchFn });

const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const file = (text: string, sha: string): [number, unknown] => [200, { content: base64(text), encoding: "base64", sha, size: Buffer.byteLength(text) }];

test("the folders are the directories of Accounts, Partners and Events, roots first", async () => {
  const { calls, fetchFn } = fakeApi({
    "GET https://api.github.com/repos/demo/notes/contents/Accounts": [200, [
      { name: "Acme", type: "dir" },
      { name: "README.md", type: "file" },
      { name: "Globex", type: "dir" },
    ]],
    "GET https://api.github.com/repos/demo/notes/contents/Partners": [200, [{ name: "Globex", type: "dir" }]],
    // A root the notes repo does not have yet.
    "GET https://api.github.com/repos/demo/notes/contents/Events": [404, { message: "Not Found" }],
  });

  assert.deepEqual(await client(fetchFn).listFolders(), ["Accounts/Acme", "Accounts/Globex", "Partners/Globex"]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].init.headers, { authorization: "Bearer gh-1", accept: "application/vnd.github+json" });
  assert.equal(calls[0].init.body, undefined, "a read carries no body");
  assert.ok(calls[0].init.signal instanceof AbortSignal, "every call carries a timeout");
});

test("a missing file is null, a file is its text and the sha a write has to carry", async () => {
  const { calls, fetchFn } = fakeApi({
    "GET https://api.github.com/repos/demo/notes/contents/Accounts/Acme%20Ltd/README.md": file("# Acme Ltd\n\n## Log\n", "sha-1"),
    "GET https://api.github.com/repos/demo/notes/contents/Accounts/Nobody/README.md": [404, { message: "Not Found" }],
  });
  const notes = client(fetchFn);

  assert.deepEqual(await notes.readFile("Accounts/Acme Ltd/README.md"), { text: "# Acme Ltd\n\n## Log\n", sha: "sha-1" });
  assert.equal(await notes.readFile("Accounts/Nobody/README.md"), null);
  assert.equal(calls[0].url, "https://api.github.com/repos/demo/notes/contents/Accounts/Acme%20Ltd/README.md", "each segment is encoded, the separators are not");
});

test("a write puts the base64 of the text and the sha it read, and returns the commit url", async () => {
  const { calls, fetchFn } = fakeApi({
    "PUT https://api.github.com/repos/demo/notes/contents/Accounts/Acme/README.md": [200, {
      commit: { html_url: "https://github.com/demo/notes/commit/abc123" },
    }],
  });
  const notes = client(fetchFn);
  const text = "## 2026-11-25 · Workshop · Acme sizing\n\n**Summary:** café, 30 % more.\n";

  assert.equal(await notes.writeFile("Accounts/Acme/README.md", text, "sha-1", "notes(Accounts/Acme): 2026-11-25 Acme sizing [scribe]"), "https://github.com/demo/notes/commit/abc123");
  assert.equal(calls[0].init.method, "PUT");
  assert.equal((calls[0].init.headers as Record<string, string>)["content-type"], "application/json");
  const body = JSON.parse(String(calls[0].init.body)) as { message: string; content: string; sha?: string };
  assert.equal(body.message, "notes(Accounts/Acme): 2026-11-25 Acme sizing [scribe]");
  assert.equal(body.sha, "sha-1");
  assert.equal(Buffer.from(body.content, "base64").toString("utf8"), text, "non-ASCII survives the base64 round trip");
});

test("a new file is written without a sha", async () => {
  const { calls, fetchFn } = fakeApi({
    "PUT https://api.github.com/repos/demo/notes/contents/Accounts/Acme/README.md": [201, {
      commit: { html_url: "https://github.com/demo/notes/commit/new" },
    }],
  });
  await client(fetchFn).writeFile("Accounts/Acme/README.md", "x\n", null, "notes(Accounts/Acme): 2026-11-25 t [scribe]");
  assert.deepEqual(Object.keys(JSON.parse(String(calls[0].init.body))).sort(), ["content", "message"]);
});

test("a sha that no longer matches is a ShaConflict, so the caller can read again", async () => {
  for (const status of [409, 422]) {
    const { fetchFn } = fakeApi({
      "PUT https://api.github.com/repos/demo/notes/contents/Accounts/Acme/README.md": [status, { message: "sha does not match" }],
    });
    await assert.rejects(client(fetchFn).writeFile("Accounts/Acme/README.md", "x\n", "sha-old", "m"), ShaConflict);
  }
});

test("any other refusal is an error that names the status, not a conflict", async () => {
  const { fetchFn } = fakeApi({
    "PUT https://api.github.com/repos/demo/notes/contents/Accounts/Acme/README.md": [500, { message: "boom" }],
  });
  await assert.rejects(client(fetchFn).writeFile("Accounts/Acme/README.md", "x\n", null, "m"), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err instanceof ShaConflict, false);
    assert.match(err.message, /write Accounts\/Acme\/README\.md: GitHub API 500: .*boom/);
    return true;
  });
});

test("a README the Contents API would not return in full is a failure, never an overwrite", async () => {
  // Over 1 MB the API answers with an empty content and encoding "none": writing
  // what we would make of that would destroy the file, so the read throws.
  const tooLarge = file("", "sha-1");
  (tooLarge[1] as Record<string, unknown>).content = "";
  (tooLarge[1] as Record<string, unknown>).encoding = "none";
  (tooLarge[1] as Record<string, unknown>).size = 2_000_000;
  const { calls, fetchFn } = fakeApi({
    "GET https://api.github.com/repos/demo/notes/contents/Accounts/Acme/README.md": tooLarge,
  });

  await assert.rejects(client(fetchFn).readFile("Accounts/Acme/README.md"), /file too large for the Contents API/);
  assert.equal(calls.length, 1);

  const emptyButBase64: [number, unknown] = [200, { content: "", encoding: "base64", sha: "sha-1", size: 40 }];
  const truncated = fakeApi({ "GET https://api.github.com/repos/demo/notes/contents/Accounts/Acme/README.md": emptyButBase64 });
  await assert.rejects(client(truncated.fetchFn).readFile("Accounts/Acme/README.md"), /file too large for the Contents API/);
});

test("a path that is not a folder's README is refused before any request", async () => {
  const { calls, fetchFn } = fakeApi({});
  const notes = client(fetchFn);

  for (const path of ["../../x/README.md", "Accounts/../README.md", ".github/workflows/x.yml", "Accounts/Acme/notes.md", "Accounts/Acme\\x/README.md"]) {
    await assert.rejects(notes.readFile(path), /notes: refusing the path/);
    await assert.rejects(notes.writeFile(path, "x", null, "m"), /notes: refusing the path/);
  }
  assert.equal(calls.length, 0, "nothing reached the network");
});

test("a folder no write may use is never listed, so it is never offered", async () => {
  const { fetchFn } = fakeApi({
    "GET https://api.github.com/repos/demo/notes/contents/Accounts": [200, [
      { name: "Acme", type: "dir" },
      { name: "Acme.Inc", type: "dir" },
      { name: ".github", type: "dir" },
      { name: "A".repeat(65), type: "dir" },
      { name: "Jurong Demo", type: "dir" },
    ]],
    "GET https://api.github.com/repos/demo/notes/contents/Partners": [404, { message: "Not Found" }],
    "GET https://api.github.com/repos/demo/notes/contents/Events": [404, { message: "Not Found" }],
  });
  assert.deepEqual(await client(fetchFn).listFolders(), ["Accounts/Acme", "Accounts/Jurong Demo"]);
});
