// `zya update` without a network: the board is FakeBoard, which records every
// write in the order it was made, and every plan is planned against the board it
// will be written to. Synthetic names only: "demo", "Acme".

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runUpdateCli, type UpdateCliDeps } from "../src/cli.ts";
import type { Env } from "../src/env.ts";
import { createBoardClient, type BoardField, type FetchLike } from "../src/github.ts";
import type { Item } from "../src/rules.ts";
import { applyUpdate, planUpdate } from "../src/update.ts";
import { item } from "./board.ts";
import { FakeBoard } from "./fakes.ts";

const ENV: Env = { token: "test", owner: "rhapsody008", number: 1, notesRepo: "demo/notes", tz: "Asia/Singapore" };

/** The board's fields: the names an update writes, their ids, and the types it checks. */
const FIELDS: Array<[string, BoardField]> = [
  [
    "Status",
    {
      id: "F_STATUS",
      kind: "singleSelect",
      options: new Map([
        ["Next", "O_NEXT"],
        ["In progress", "O_PROGRESS"],
        ["Waiting", "O_WAITING"],
        ["Done", "O_DONE"],
      ]),
    },
  ],
  ["Target date", { id: "F_TARGET", kind: "date" }],
  ["Next touch", { id: "F_TOUCH", kind: "date" }],
  ["Next action", { id: "F_ACTION", kind: "text" }],
  ["Waiting on", { id: "F_WAITING", kind: "text" }],
];

/** The item an update is about: an issue, so it has a comment subject. */
const ISSUE: Item = item({
  id: "ITEM_52",
  ref: "demo#52",
  title: "Chase Acme",
  url: "https://github.com/demo/notes/issues/52",
  nextTouch: "2026-11-25",
  contentId: "I_52",
});

/** A draft: no issue stands behind it, so a comment has nowhere to go. */
const DRAFT: Item = item({
  id: "ITEM_9",
  ref: "draft",
  title: "Draft idea",
  url: "https://github.com/users/rhapsody008/projects/1",
  contentId: null,
});

function fakeBoard(): FakeBoard {
  const board = new FakeBoard();
  board.board.fields = new Map(FIELDS);
  board.board.items = [ISSUE, DRAFT];
  return board;
}

/** The deps of one run, and the sink it writes to. */
function setup(board: FakeBoard): { deps: UpdateCliDeps; written: string[] } {
  const written: string[] = [];
  return { deps: { board, out: (s) => written.push(s), env: ENV }, written };
}

/** One page of the board as GitHub sends it: the fields an update writes, and its one issue. */
const PAGE = {
  data: {
    user: {
      projectV2: {
        id: "PVT_1",
        title: "Board",
        fields: {
          nodes: [
            { __typename: "ProjectV2Field", id: "F_ACTION", name: "Next action", dataType: "TEXT" },
            { __typename: "ProjectV2Field", id: "F_WAITING", name: "Waiting on", dataType: "TEXT" },
          ],
        },
        items: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "ITEM_7",
              updatedAt: "2026-11-20T00:00:00Z",
              fieldValues: { nodes: [] },
              content: {
                __typename: "Issue",
                id: "I_7",
                number: 7,
                title: "Chase Acme",
                url: "https://github.com/demo/notes/issues/7",
                state: "OPEN",
                updatedAt: "2026-11-20T00:00:00Z",
                repository: { name: "notes" },
              },
            },
          ],
        },
      },
    },
  },
};

/** A GitHub of our own: the board page, then each mutation's own answer, by mutation name. */
function fakeGithub(answers: Record<string, unknown>): { fetchFn: FetchLike; sent: string[] } {
  const sent: string[] = [];
  const fetchFn: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { query: string };
    const name = /mutation (\w+)/.exec(body.query)?.[1] ?? "Board";
    sent.push(name);
    return new Response(JSON.stringify({ data: name === "Board" ? PAGE.data : answers[name] ?? {} }), { status: 200 });
  };
  return { fetchFn, sent };
}

test("the plan is one op per flag, in board order, the comment last", () => {
  const plan = planUpdate(fakeBoard().board, {
    ref: "demo#52",
    status: "Done",
    target: "2026-12-02",
    nextTouch: "none",
    nextAction: "chase Dana",
    waitingOn: "",
    comment: "moved out of the workshop",
  });

  assert.equal(plan.projectId, "PVT_1");
  assert.equal(plan.item.id, "ITEM_52");
  // Each op carries the ids it writes with, resolved while planning: the plan
  // that was checked is the plan that runs.
  assert.deepEqual(plan.ops, [
    { kind: "select", field: "Status", fieldId: "F_STATUS", optionId: "O_DONE", value: "Done" },
    { kind: "date", field: "Target date", fieldId: "F_TARGET", value: "2026-12-02" },
    // "none" clears a date, an empty text clears a text: a date holds no empty date.
    { kind: "clear", field: "Next touch", fieldId: "F_TOUCH", value: "none" },
    { kind: "text", field: "Next action", fieldId: "F_ACTION", value: "chase Dana" },
    { kind: "clear", field: "Waiting on", fieldId: "F_WAITING", value: "" },
    { kind: "comment", field: "Comment", subjectId: "I_52", value: "moved out of the workshop" },
  ]);
  // Every op says what it writes and what it writes there, the comment included.
  for (const op of plan.ops) assert.deepEqual(["kind", "field", "value"].filter((key) => key in op), ["kind", "field", "value"]);
});

test("the item is found by its ref or by its project item id", () => {
  const board = fakeBoard().board;
  assert.equal(planUpdate(board, { ref: "demo#52", status: "Next" }).item.id, "ITEM_52");
  assert.equal(planUpdate(board, { ref: "ITEM_52", status: "Next" }).item.ref, "demo#52");
});

test("a plan applies through the two-argument API, with no board read of its own", async () => {
  const board = fakeBoard();
  const plan = planUpdate(board.board, { ref: "ITEM_52", nextAction: "chase Dana", comment: "chase went out" });

  const result = await applyUpdate(board, plan);

  assert.deepEqual(result, {
    applied: [
      { kind: "text", field: "Next action", fieldId: "F_ACTION", value: "chase Dana" },
      { kind: "comment", field: "Comment", subjectId: "I_52", value: "chase went out" },
    ],
  });
  assert.deepEqual(board.calls, ["setText ITEM_52|Next action|chase Dana", "addComment I_52|chase went out"]);
});

test("a field write the API did not acknowledge stops the comment that would follow it", async () => {
  const { fetchFn, sent } = fakeGithub({
    SetText: { updateProjectV2ItemFieldValue: null },
    AddComment: { addComment: { commentEdge: { node: { id: "IC_1" } } } },
  });
  const client = createBoardClient("test-token", fetchFn);
  const plan = planUpdate(await client.fetchBoard("rhapsody008", 1), {
    ref: "notes#7",
    nextAction: "chase Dana",
    comment: "chase went out",
  });

  const result = await applyUpdate(client, plan);

  assert.deepEqual(sent, ["Board", "SetText"], "nothing is written after an unconfirmed one");
  assert.deepEqual(result.applied, []);
  assert.equal(result.failed?.op.kind, "text");
  assert.equal(result.failed?.error, "updateProjectV2ItemFieldValue: the response holds null, not the item ITEM_7");
});

test("a comment the API did not acknowledge is the failure, the writes before it kept", async () => {
  const { fetchFn, sent } = fakeGithub({
    SetText: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_7" } } },
    AddComment: { addComment: null },
  });
  const client = createBoardClient("test-token", fetchFn);
  const plan = planUpdate(await client.fetchBoard("rhapsody008", 1), {
    ref: "notes#7",
    nextAction: "chase Dana",
    comment: "chase went out",
  });

  const result = await applyUpdate(client, plan);

  assert.deepEqual(sent, ["Board", "SetText", "AddComment"]);
  assert.deepEqual(result.applied, [{ kind: "text", field: "Next action", fieldId: "F_ACTION", value: "chase Dana" }]);
  // A comment op says what it writes like the rest, and names the issue it went to.
  assert.deepEqual(result.failed, {
    op: { kind: "comment", field: "Comment", subjectId: "I_7", value: "chase went out" },
    error: "addComment: the response holds no comment id",
  });
});

test("--dry-run prints the plan and writes nothing: each op says what it writes, never the ids", async () => {
  const board = fakeBoard();
  const { deps, written } = setup(board);

  assert.equal(await runUpdateCli(["update", "--ref", "demo#52", "--target", "none", "--comment", "moved", "--dry-run"], deps), 0);

  assert.deepEqual(board.calls, ["fetchBoard"], "the plan's read is the only call a dry run makes");
  const json = JSON.parse(written.join("")) as { item: { id: string; ref: string }; ops: unknown[] };
  // The plan's item, and its ops as a person reads them: the field and option ids
  // a write resolves, and the project id, stay in the plan.
  assert.deepEqual(Object.keys(json), ["item", "ops"]);
  assert.equal(json.item.id, "ITEM_52");
  assert.equal(json.item.ref, "demo#52");
  assert.deepEqual(json.ops, [
    { kind: "clear", field: "Target date", value: "none" },
    { kind: "comment", field: "Comment", value: "moved" },
  ]);
});

test("a refused update writes nothing: the item, the option, the types and the dates are checked first", async () => {
  const cases: Array<[string[], RegExp]> = [
    [["--ref", "demo#99", "--status", "Done"], /update: the board has no item "demo#99"/],
    [["--ref", "demo#52", "--status", "Archived"], /update: Status has no option "Archived" \(one of Next, In progress, Waiting, Done\)/],
    [["--ref", "demo#52", "--target", "2026-02-30"], /update: Target date must be a date like 2026-11-25/],
    [["--ref", "demo#52", "--next-touch", "02/12/2026"], /update: Next touch must be a date like 2026-11-25/],
    [["--ref", "demo#52", "--comment", "  "], /update: a comment cannot be empty/],
  ];

  for (const [args, message] of cases) {
    const board = fakeBoard();
    const { deps, written } = setup(board);
    await assert.rejects(() => runUpdateCli(["update", ...args], deps), message, args.join(" "));
    // The board was read, to be able to refuse at all; nothing was written.
    assert.deepEqual(board.calls, ["fetchBoard"], `${args.join(" ")} must write nothing`);
    assert.deepEqual(written, [], `${args.join(" ")} must print nothing`);
  }
});

test("a ref the board holds twice is refused: only the item id names one item", async () => {
  const board = fakeBoard();
  // Every draft carries the ref "draft" (src/github.ts), so a ref is no unique name.
  board.board.items.push(
    item({
      id: "ITEM_10",
      ref: "draft",
      title: "Another draft",
      url: "https://github.com/users/rhapsody008/projects/1",
      contentId: null,
    }),
  );
  const { deps, written } = setup(board);

  await assert.rejects(
    () => runUpdateCli(["update", "--ref", "draft", "--next-action", "chase Dana"], deps),
    /update: "draft" names 2 items \(ITEM_9, ITEM_10\): use the project item id/,
  );
  assert.deepEqual(board.calls, ["fetchBoard"], "an ambiguous ref writes nothing");
  assert.deepEqual(written, []);

  // The id names exactly one item, whichever way the board is ordered.
  board.board.items.reverse();
  assert.equal(await runUpdateCli(["update", "--ref", "ITEM_10", "--next-action", "chase Dana"], deps), 0);
  assert.deepEqual(board.calls, ["fetchBoard", "fetchBoard", "setText ITEM_10|Next action|chase Dana"]);
});

test("an item whose content id is blank has no issue to comment on either, and nothing is written", async () => {
  const board = fakeBoard();
  board.board.items.push(
    item({ id: "ITEM_11", ref: "notes#11", title: "No content id", url: "https://github.com/demo/notes/issues/11", contentId: "" }),
  );
  const { deps, written } = setup(board);

  // The text op is planned before the comment: a comment on a blank subject would
  // be sent after it, leaving a half-written item behind a GitHub refusal.
  await assert.rejects(
    () => runUpdateCli(["update", "--ref", "notes#11", "--next-action", "chase Dana", "--comment", "chase went out"], deps),
    /update: notes#11 has no issue to comment on/,
  );
  assert.deepEqual(board.calls, ["fetchBoard"], "the plan is refused before the first write");
  assert.deepEqual(written, []);
});

test("a field the board typed as something else is refused, a clear included, before any write", async () => {
  const cases: Array<[BoardField, string[], RegExp]> = [
    // The name says date, the board says single select: a clear would empty the wrong field.
    [{ id: "F_TARGET", kind: "singleSelect", options: new Map([["Soon", "O_SOON"]]) }, ["--target", "none"], /update: Target date is a single select field on this board, not a date field/],
    [{ id: "F_WAITING", kind: "date" }, ["--waiting-on", "Dana"], /update: Waiting on is a date field on this board, not a text field/],
    // A field whose type the response never gave: no write knows what is in it.
    [{ id: "F_ACTION" }, ["--next-action", "chase Dana"], /update: Next action is a field of no known type on this board, not a text field/],
  ];

  for (const [field, args, message] of cases) {
    const board = fakeBoard();
    const name = args[0] === "--target" ? "Target date" : args[0] === "--waiting-on" ? "Waiting on" : "Next action";
    board.board.fields.set(name, field);
    const { deps, written } = setup(board);

    // A valid first op: the status is planned before the mistyped field, and none of it lands.
    await assert.rejects(() => runUpdateCli(["update", "--ref", "demo#52", "--status", "Done", ...args], deps), message);
    assert.deepEqual(board.calls, ["fetchBoard"], `${name} mistyped must write nothing`);
    assert.deepEqual(written, []);
  }
});

test("a draft is refused a comment before any of the update is written", async () => {
  const board = fakeBoard();
  const { deps, written } = setup(board);

  await assert.rejects(
    () => runUpdateCli(["update", "--ref", "draft", "--status", "Done", "--comment", "done now"], deps),
    /update: draft has no issue to comment on/,
  );

  // The Status op of the same run never happened either: the plan is all or nothing.
  assert.deepEqual(board.calls, ["fetchBoard"]);
  assert.deepEqual(written, []);
});

test("the ops are written in order, with their values and the comment body, last", async () => {
  const board = fakeBoard();
  const { deps, written } = setup(board);

  const code = await runUpdateCli(
    [
      "update",
      "--ref",
      "demo#52",
      "--next-action",
      "chase Dana",
      "--status",
      "Done",
      "--target",
      "2026-12-02",
      "--next-touch",
      "none",
      "--waiting-on",
      "Dana's answer",
      "--comment",
      "moved out of the workshop",
    ],
    deps,
  );

  assert.equal(code, 0);
  assert.deepEqual(board.calls, [
    "fetchBoard",
    "setSingleSelect ITEM_52|Status|Done",
    "setDate ITEM_52|Target date|2026-12-02",
    "clearField ITEM_52|Next touch",
    "setText ITEM_52|Next action|chase Dana",
    "setText ITEM_52|Waiting on|Dana's answer",
    // Last, on values that are already there, with the body it was given.
    "addComment I_52|moved out of the workshop",
  ]);

  // A success is the result's public shape: no `failed` key at all, and each op
  // as its kind, field and value — the ids the writes used are not printed.
  const json = JSON.parse(written.join("")) as { applied: Array<Record<string, unknown>>; failed?: unknown };
  assert.deepEqual(Object.keys(json), ["applied"]);
  assert.deepEqual(json.applied, [
    { kind: "select", field: "Status", value: "Done" },
    { kind: "date", field: "Target date", value: "2026-12-02" },
    { kind: "clear", field: "Next touch", value: "none" },
    { kind: "text", field: "Next action", value: "chase Dana" },
    { kind: "text", field: "Waiting on", value: "Dana's answer" },
    { kind: "comment", field: "Comment", value: "moved out of the workshop" },
  ]);
});

test("an empty --waiting-on clears that field, and only that one", async () => {
  const board = fakeBoard();
  const { deps, written } = setup(board);

  assert.equal(await runUpdateCli(["update", "--ref", "demo#52", "--waiting-on", ""], deps), 0);

  assert.deepEqual(board.calls, ["fetchBoard", "clearField ITEM_52|Waiting on"]);
  const json = JSON.parse(written.join("")) as { applied: unknown[] };
  assert.deepEqual(json.applied, [{ kind: "clear", field: "Waiting on", value: "" }]);
});

test("a write that fails stops the plan and reports what landed and what did not", async () => {
  const board = fakeBoard();
  board.failAt = "setDate";
  board.failWith = "GitHub GraphQL: Could not resolve to a node";
  const { deps, written } = setup(board);

  const code = await runUpdateCli(
    ["update", "--ref", "demo#52", "--status", "Done", "--target", "2026-12-02", "--comment", "moved"],
    deps,
  );

  assert.equal(code, 1, "a failure is exit 1");
  assert.deepEqual(board.calls, ["fetchBoard", "setSingleSelect ITEM_52|Status|Done"], "the date and the comment never ran");

  const json = JSON.parse(written.join("")) as { applied: unknown; failed: unknown };
  assert.deepEqual(Object.keys(json), ["applied", "failed"], "a failure is the result's own `failed`");
  // What landed, and the one op that was attempted but not confirmed: its write
  // may have reached the board, so it is named the same way, and so is nothing else.
  assert.deepEqual(json.applied, [{ kind: "select", field: "Status", value: "Done" }]);
  assert.deepEqual(json.failed, {
    op: { kind: "date", field: "Target date", value: "2026-12-02" },
    error: "GitHub GraphQL: Could not resolve to a node",
  });
});

test("an update with no field and no comment is a usage error: 2, nothing read, nothing written", async (t) => {
  const board = fakeBoard();
  const { deps, written } = setup(board);
  // The runner's own mock: restored when this test ends, so no other test sees it.
  const stderr = t.mock.method(process.stderr, "write", () => true);

  const bad = [
    ["update", "--ref", "demo#52"],
    ["update", "--ref", "demo#52", "--dry-run"],
    ["update", "--ref", "demo#52", "--format", "json"],
    ["update", "--status", "Done"],
    ["update"],
    ["update", "--ref", "demo#52", "--status", "Done", "extra"],
  ];
  for (const argv of bad) {
    const code = await runUpdateCli(argv, deps);
    assert.equal(code, 2, `${argv.join(" ")} must exit 2`);
  }

  const err = stderr.mock.calls.map((call) => String(call.arguments[0])).join("");
  assert.match(err, /zya update --ref R \[--status S\]/, "every usage error prints the usage");
  // The guidance a stopped run leaves behind: an unconfirmed write is not a lost one.
  assert.match(err, /one it could not confirm, which may have landed: check the item before/);
  assert.deepEqual(board.calls, [], "a usage error reads nothing");
  assert.deepEqual(written, [], "and prints nothing to the sink");
});

/** The entry `bin/zya` execs: the same file, so the dispatch is what these tests run. */
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/**
 * The entry as a process, with a fetch of our own. The preload is a data: URL, so
 * nothing on disk is written and the machine's own credentials and env file are
 * out of reach (HOME points nowhere, GITHUB_TOKEN is a synthetic one).
 */
function zya(hook: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(hook)}`, CLI, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      HOME: join(tmpdir(), "zya-test-no-home"),
      GITHUB_TOKEN: "test-token",
      PROJECT_OWNER: "rhapsody008",
      PROJECT_NUMBER: "1",
      ASSISTANT_TZ: "Asia/Singapore",
    },
  });
  assert.equal(run.error, undefined);
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

test("the real entry dispatches update: a --dry-run prints the plan and writes nothing", () => {
  // The board answers; any mutation throws, so a dry run that wrote anything exits 1.
  const hook = `
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (String(body.query).includes("mutation ")) throw new Error("a mutation was sent by a dry run");
      return new Response(${JSON.stringify(JSON.stringify(PAGE))}, { status: 200 });
    };
  `;

  const { status, stdout, stderr } = zya(hook, ["update", "--ref", "notes#7", "--waiting-on", "Dana", "--dry-run"]);

  assert.equal(stderr, "");
  assert.equal(status, 0);
  const plan = JSON.parse(stdout) as { item: { id: string; ref: string }; ops: Array<Record<string, unknown>> };
  assert.equal(plan.item.id, "ITEM_7");
  assert.equal(plan.item.ref, "notes#7");
  assert.deepEqual(plan.ops, [{ kind: "text", field: "Waiting on", value: "Dana" }]);
});
