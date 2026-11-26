// `zya update`: change the fields of one board item, and leave a comment on its
// issue. Two halves, split the way the rest of this code is: planUpdate is pure —
// it reads the board it is given, refuses what GitHub would refuse, and writes
// nothing — and applyUpdate writes the ops in order and stops at the first
// failure. A dry run is this plan, printed, with nothing written.
//
// Planning resolves everything a write needs (the field's id, the option's id,
// the issue's id), so the plan that was checked is the plan that runs: applyUpdate
// never reads a second board, and nothing it writes is looked up again after the
// checks.
//
// The clear words are GitHub's own: a date is cleared with "none" (a date field
// holds no empty date), a text with an empty string, and both go through the
// clear mutation rather than writing an empty value.

import { errMessage } from "./errors.ts";
import type { Board, BoardField, BoardFieldKind, BoardSource } from "./github.ts";
import type { Item } from "./rules.ts";
import { FIELD } from "./schema.ts";

/** What one update was asked for. A field left out is a field left alone. */
export interface UpdateArgs {
  /** The item: its project item id, or its ref when the board has exactly one of it. */
  ref: string;
  /** A Status option name the board has. */
  status?: string;
  /** YYYY-MM-DD, or "none" to clear the date. */
  target?: string;
  nextTouch?: string;
  /** A text; an empty string clears it. */
  nextAction?: string;
  waitingOn?: string;
  /** A comment on the item's issue: empty, or on a draft, is refused. */
  comment?: string;
}

/**
 * One write of an update, in the order the update makes them. Every op names what
 * it writes (`field`) and what it writes there (`value`); a field op carries the
 * ids the write needs — resolved while planning, so nothing is looked up again —
 * and a comment carries the issue it goes on.
 */
export type Op =
  | { kind: "select"; field: string; fieldId: string; optionId: string; value: string }
  | { kind: "date" | "text" | "clear"; field: string; fieldId: string; value: string }
  | { kind: "comment"; field: string; subjectId: string; value: string };

/** What an update would write, in the order it would write it. */
export interface UpdatePlan {
  projectId: string;
  item: Item;
  ops: Op[];
}

/**
 * What an update did. `applied` is the writes GitHub confirmed; `failed.op` is the
 * one the run was attempting when the acknowledgement did not arrive, so it may
 * have landed after all, and every op after it was never attempted.
 */
export interface UpdateResult {
  applied: Op[];
  failed?: { op: Op; error: string };
}

/**
 * One op as anything printed says it: what it writes and what it writes there,
 * and none of the ids a write needs. Those are resolved while planning and stay
 * in the plan — they are the plan's business, not something a person reading the
 * output checks or acts on.
 */
export function publicOp(op: Op): { kind: Op["kind"]; field: string; value: string } {
  return { kind: op.kind, field: op.field, value: op.value };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The word that clears a date field: a date has no empty date to write. */
const NONE = "none";

/** What a comment op writes: the issue, not one of the board's fields. */
const COMMENT = "Comment";

/**
 * A day, and only a day: the shape alone accepts 2026-02-30, which the board
 * would read as 2 March, and 2026-13-45, which it cannot read at all. A date
 * that does not come back as itself is not the date the caller asked for. The
 * CLI's --date is this same rule, which is why it lives here and is exported.
 */
export function isDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * The item a ref names. An id is exact and is taken first; a ref is only an item
 * when the board has exactly one of it, because a ref is not unique (every draft
 * is "draft", and "notes#12" says nothing about the owner) and an update that
 * guessed would write to the wrong item.
 */
function itemOf(board: Board, ref: string): Item {
  const byId = board.items.find((one) => one.id === ref);
  if (byId !== undefined) return byId;
  const named = board.items.filter((one) => one.ref === ref);
  if (named.length === 1) return named[0];
  if (named.length > 1) {
    const which = named.map((one) => one.id).join(", ");
    throw new Error(`update: ${JSON.stringify(ref)} names ${named.length} items (${which}): use the project item id`);
  }
  throw new Error(`update: the board has no item ${JSON.stringify(ref)}`);
}

/** A kind as the noun phrase a refusal uses: "Target date is not a date field on this board". */
function fieldNoun(kind: BoardFieldKind): string {
  switch (kind) {
    case "singleSelect":
      return "a single select field";
    case "date":
      return "a date field";
    case "text":
      return "a text field";
    case "other":
      return "a field of another type";
  }
}

/**
 * A field the board has, by name, of the type this write puts in it: a board's
 * field may carry another type than the name promises, and a clear takes no
 * typed value, so nothing but the board's own dataType can tell them apart.
 */
function fieldOf(board: Board, name: string, kind: BoardFieldKind): BoardField {
  const field = board.fields.get(name);
  if (field === undefined) throw new Error(`update: the board has no field ${JSON.stringify(name)}`);
  if (field.kind !== kind) {
    const found = field.kind === undefined ? "a field of no known type" : fieldNoun(field.kind);
    throw new Error(`update: ${name} is ${found} on this board, not ${fieldNoun(kind)}`);
  }
  return field;
}

/** A status: an option the board's Status field offers, so a typo never reaches GitHub. */
function selectOp(board: Board, option: string): Op {
  const field = fieldOf(board, FIELD.status, "singleSelect");
  const optionId = field.options?.get(option);
  if (optionId === undefined) {
    const known = [...(field.options?.keys() ?? [])];
    const which = known.length === 0 ? "" : ` (one of ${known.join(", ")})`;
    throw new Error(`update: ${FIELD.status} has no option ${JSON.stringify(option)}${which}`);
  }
  return { kind: "select", field: FIELD.status, fieldId: field.id, optionId, value: option };
}

/** A date, or the clear of one. */
function dateOp(board: Board, name: string, value: string): Op {
  const field = fieldOf(board, name, "date");
  if (value === NONE) return { kind: "clear", field: name, fieldId: field.id, value };
  if (!isDate(value)) {
    throw new Error(`update: ${name} must be a date like 2026-11-25, or ${NONE} to clear it, got ${JSON.stringify(value)}`);
  }
  return { kind: "date", field: name, fieldId: field.id, value };
}

/** A text, or the clear of one: an empty text is the clear. */
function textOp(board: Board, name: string, value: string): Op {
  const field = fieldOf(board, name, "text");
  if (value === "") return { kind: "clear", field: name, fieldId: field.id, value };
  return { kind: "text", field: name, fieldId: field.id, value };
}

/** A comment on the item's issue. A draft and a pull request have none, and an empty one is no comment. */
function commentOp(item: Item, body: string): Op {
  if (body.trim() === "") throw new Error("update: a comment cannot be empty");
  // No issue, or an issue id the board left blank: a comment on that subject goes
  // nowhere, and it would go there after the fields of the same update were
  // already written.
  if (item.contentId === null || item.contentId.trim() === "") {
    throw new Error(`update: ${item.ref} has no issue to comment on`);
  }
  return { kind: "comment", field: COMMENT, subjectId: item.contentId, value: body };
}

/**
 * What this update writes, in order: the status, the two dates, the two texts,
 * then the comment last, so it lands on values that are already there. Everything
 * is checked here — the item, the option, each field's type, the dates, the
 * comment's subject — so a refused update writes nothing at all.
 */
export function planUpdate(board: Board, args: UpdateArgs): UpdatePlan {
  const item = itemOf(board, args.ref);
  const ops: Op[] = [];
  if (args.status !== undefined) ops.push(selectOp(board, args.status));
  if (args.target !== undefined) ops.push(dateOp(board, FIELD.target, args.target));
  if (args.nextTouch !== undefined) ops.push(dateOp(board, FIELD.nextTouch, args.nextTouch));
  if (args.nextAction !== undefined) ops.push(textOp(board, FIELD.nextAction, args.nextAction));
  if (args.waitingOn !== undefined) ops.push(textOp(board, FIELD.waitingOn, args.waitingOn));
  if (args.comment !== undefined) ops.push(commentOp(item, args.comment));
  return { projectId: board.projectId, item, ops };
}

/**
 * The plan, written to the board in its own order, stopping at the first failure.
 * The result separates what GitHub confirmed from what it did not: `failed.op`
 * was attempted, so a lost acknowledgement means it may have landed, and the ops
 * after it were never attempted. Nothing here retries — a comment sent a second
 * time is a comment posted twice — so a retry reads the item or the issue first.
 */
export async function applyUpdate(source: BoardSource, plan: UpdatePlan): Promise<UpdateResult> {
  const applied: Op[] = [];
  for (const op of plan.ops) {
    try {
      await write(source, plan, op);
    } catch (err) {
      return { applied, failed: { op, error: errMessage(err) } };
    }
    applied.push(op);
  }
  return { applied };
}

/** One op, through the call that writes it: the ids planning resolved and nothing else. */
async function write(source: BoardSource, plan: UpdatePlan, op: Op): Promise<void> {
  switch (op.kind) {
    case "comment":
      await source.addComment(op.subjectId, op.value);
      return;
    case "select":
      await source.setSingleSelect(plan.projectId, plan.item.id, op.fieldId, op.optionId);
      return;
    case "date":
      await source.setDate(plan.projectId, plan.item.id, op.fieldId, op.value);
      return;
    case "text":
      await source.setText(plan.projectId, plan.item.id, op.fieldId, op.value);
      return;
    case "clear":
      await source.clearField(plan.projectId, plan.item.id, op.fieldId);
  }
}
