// The renderer: the briefing is written in Slack's markup, and this is the one
// place that spells it for a file and for a terminal. A bug here is a link that
// does not work, so the three shapes are pinned exactly, on the row the briefing
// actually builds.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Brief } from "../src/brief.ts";
import { renderBrief, renderText } from "../src/render.ts";

/** A row as rules.ts builds one: a Slack link, then the item's reason. */
const ROW = "<https://x/1|demo#1> A: *overdue*";

test("slack leaves the briefing's own markup alone", () => {
  assert.equal(renderText(ROW, "slack"), ROW);
});

test("md writes a markdown link and double emphasis", () => {
  assert.equal(renderText(ROW, "md"), "[demo#1](https://x/1) A: **overdue**");
});

test("plain puts the url behind its text and drops the asterisks", () => {
  assert.equal(renderText(ROW, "plain"), "demo#1 (https://x/1) A: overdue");
});

test("renderBrief renders the whole briefing, its rows and its headers", () => {
  const briefing: Brief = {
    date: "2026-11-27",
    text: ["*Morning briefing, Fri 27 Nov*", `*Today*\n• ${ROW}`, "*In progress:* 1"].join("\n\n"),
    head: ["*Morning briefing, Fri 27 Nov*", "*Today*"],
    rows: [{ itemId: "I1", text: ROW }],
    tail: ["*In progress:* 1"],
  };

  const md = renderBrief(briefing, "md");
  assert.match(md, /^\*\*Morning briefing, Fri 27 Nov\*\*\n\n/);
  assert.ok(md.includes(`• [demo#1](https://x/1) A: **overdue**`));
  assert.ok(!md.includes("<https://x/1"), "no Slack link may survive the md render");

  const plain = renderBrief(briefing, "plain");
  assert.ok(plain.includes("• demo#1 (https://x/1) A: overdue"));
  assert.ok(!plain.includes("*"), "no emphasis marker may survive the plain render");
});
