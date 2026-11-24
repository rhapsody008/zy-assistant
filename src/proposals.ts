// What a proposal card and its Edit modal are, whatever the proposal is about: a
// header, the thing itself line by line, one line of context, a row of buttons,
// and the modal inputs behind them. Which words a button carries and which
// blocks Slack gets is the Slack side's business: a proposal is, here, a stored
// row with a kind, a payload and progress, and nothing else.
//
// The behaviour on top of the shapes is generic too. A click is the approval:
// one function claims the row, runs the kind's apply, and draws the outcome;
// another takes the Edit modal's submit. A kind arrives as a ProposalSpec and
// how a card is shown as a ProposalUi, so Slack is the production pair and a
// recording fake is a test one, and nothing here imports Slack, GitHub or a
// board.
//
// `add:` is the first user: the item a sentence drafted. The calendar's meeting
// proposals are the second, which is why nothing here mentions a board.

import { errMessage } from "./errors.ts";
import type { Proposal, ProposalStore } from "./store.ts";

/** A card's buttons, in the order they are drawn: the words are the renderer's. */
export type ProposalButton = "create" | "edit" | "cancel" | "retry";

/** What a card shows: a header, the thing itself line by line, one line of context, the buttons. */
export interface Card {
  head: string;
  lines: string[];
  context: string;
  buttons: ProposalButton[];
}

/** One input of a proposal's Edit modal. */
export type EditField =
  | { kind: "text"; name: string; label: string; value: string | null; required: boolean; maxLength: number }
  | { kind: "select"; name: string; label: string; value: string | null; options: Array<{ label: string; value: string }> }
  | { kind: "date"; name: string; label: string; value: string | null };

/** How a proposal shows itself: Slack in production, a fake in a test. */
export interface ProposalUi {
  /** Redraws the card message in place. */
  redraw(card: Card, rev: number): Promise<void>;
  /** Posts a fresh card (the old one can no longer be edited) and remembers it. */
  repost(card: Card, rev: number): Promise<void>;
  /** A line in the card's thread: where an outcome goes when the card cannot be redrawn. */
  reply(text: string): Promise<void>;
  /** Opens the Edit modal over the click's trigger_id. */
  openEdit(id: string, rev: number, fields: EditField[]): Promise<void>;
}

/** What one kind of proposal is: how it draws, how it edits, and what Apply writes. */
export interface ProposalSpec {
  /** The card of the row as the store holds it now. */
  card(proposal: Proposal): Card;
  /** The Edit modal's inputs: a kind that cannot be edited has none. */
  editFields?(proposal: Proposal): EditField[];
  /** The payload an edit submitted. A throw is the reason it was refused. */
  edited?(proposal: Proposal, values: Record<string, string | null>): string;
  /**
   * The writes behind the card. `save` persists what was written so far, and is
   * called before the next write: a retry continues, it never writes twice.
   */
  apply(proposal: Proposal, save: (progress: string) => void): Promise<void>;
}

export interface ProposalDeps {
  store: ProposalStore;
  /** The kinds this deployment can apply, by `Proposal.kind`. */
  specs: Record<string, ProposalSpec>;
  userId: string; // ZY: the only person whose clicks count
  now: () => Date;
  log: (line: string) => void;
}

/** A click on one of a card's buttons. The value carries the id and the revision. */
export interface ProposalClick {
  action: ProposalButton;
  id: string;
  rev: number;
  userId: string;
  triggerId: string | null; // needed to open the modal
  ui: ProposalUi;
}

/** What the Edit modal posts back. */
export interface ProposalEdit {
  id: string;
  rev: number;
  userId: string;
  values: Record<string, string | null>;
  ui: ProposalUi;
}

/** The value a card's buttons carry: the proposal and the revision it was drawn at. */
export function proposalValue(id: string, rev: number): string {
  return `${id}|${rev}`;
}

/**
 * What a button's value names, or null when it is not one of ours. An id may
 * hold a "|" itself, so the split is at the last one; a rev counts the edits on
 * a card, so anything but digits is no rev.
 */
export function parseProposalValue(raw: string | null): { id: string; rev: number } | null {
  if (!raw) return null;
  const at = raw.lastIndexOf("|");
  if (at <= 0) return null;
  const rev = raw.slice(at + 1);
  if (!/^\d+$/.test(rev)) return null;
  return { id: raw.slice(0, at), rev: Number(rev) };
}

/** The card as text: what carries an outcome when Slack will not take the blocks. */
export function cardText(card: Card): string {
  return [card.head, ...card.lines, card.context].join("\n");
}

/**
 * The row as the store has it now. A store that has lost it (nothing here ever
 * deletes one) leaves the copy already read, which is the newest there is.
 */
function reread(deps: ProposalDeps, row: Proposal): Proposal {
  return deps.store.findProposal(row.id) ?? row;
}

/**
 * One call to the card's ui, logged when it fails: Slack refusing a redraw or a
 * reply must never turn a write into a reported failure, and never throw.
 */
async function attempt(deps: ProposalDeps, what: string, call: () => Promise<void>): Promise<boolean> {
  try {
    await call();
    return true;
  } catch (err) {
    deps.log(`${what}: ${errMessage(err)}`);
    return false;
  }
}

/** Draws the row's card in place: the row decides what it says, its rev how clickable it is. */
async function redraw(deps: ProposalDeps, spec: ProposalSpec, ui: ProposalUi, row: Proposal): Promise<boolean> {
  return attempt(deps, `proposal ${row.id}: the redraw failed`, () => ui.redraw(spec.card(row), row.rev));
}

/** A line in the card's thread, best effort: an explanation is never the point of a click. */
async function announce(deps: ProposalDeps, ui: ProposalUi, id: string, text: string): Promise<void> {
  await attempt(deps, `proposal ${id}: the reply failed`, () => ui.reply(text));
}

/**
 * The card of an outcome: the row as the store has it now, drawn in place. When
 * Slack will not take the blocks, the card's own words go in the thread instead:
 * the outcome reaching ZY matters more than how it is shown.
 */
async function drawOutcome(deps: ProposalDeps, spec: ProposalSpec, ui: ProposalUi, id: string): Promise<void> {
  const row = deps.store.findProposal(id);
  if (row === null) {
    deps.log(`proposal ${id}: gone, the outcome has no card to draw`);
    return;
  }
  const card = spec.card(row);
  if (await attempt(deps, `proposal ${id}: the redraw failed`, () => ui.redraw(card, row.rev))) return;
  await attempt(deps, `proposal ${id}: the reply failed`, () => ui.reply(cardText(card)));
}

/**
 * A click that lost the race: the row moved on, so the click writes nothing. A
 * finished card is drawn as it is; the interim card of a click that is applying
 * right now is not worth a redraw.
 */
async function movedOn(deps: ProposalDeps, spec: ProposalSpec, ui: ProposalUi, row: Proposal): Promise<void> {
  const now = reread(deps, row);
  deps.log(`proposal ${row.id}: already ${now.status}, this click does nothing`);
  if (now.status === "done" || now.status === "cancelled") await redraw(deps, spec, ui, now);
}

/**
 * A click on a card's buttons: the approval, the edit, or the cancel. Only ZY's
 * clicks count, and a click on a card that has moved on writes nothing.
 */
export async function proposalClick(deps: ProposalDeps, click: ProposalClick): Promise<void> {
  if (click.userId !== deps.userId) return;

  const row = deps.store.findProposal(click.id);
  if (row === null) {
    deps.log(`proposal ${click.id}: unknown, this click does nothing`);
    return;
  }
  const spec = deps.specs[row.kind];
  if (spec === undefined) {
    deps.log(`proposal ${row.id}: kind ${row.kind} is not one this bot applies, this click does nothing`);
    return;
  }

  // The click came from a card drawn at a revision the row has left. Nothing is
  // written from a card nobody is looking at: the current one is drawn instead.
  if (click.rev !== row.rev) {
    deps.log(`proposal ${row.id}: stale rev ${click.rev}, the card has moved on`);
    await redraw(deps, spec, click.ui, row);
    await announce(deps, click.ui, row.id, "that card was out of date: this is the current draft");
    return;
  }

  if (click.action === "edit") {
    if (spec.editFields === undefined) {
      deps.log(`proposal ${row.id}: kind ${row.kind} cannot be edited, this click does nothing`);
      return;
    }
    // The modal opens first, over the click's own trigger_id, which is good for
    // three seconds: nothing is claimed or written, since an edit is no approval.
    try {
      await click.ui.openEdit(row.id, row.rev, spec.editFields(row));
    } catch (err) {
      deps.log(`proposal ${row.id}: the modal failed: ${errMessage(err)}`);
    }
    return;
  }

  if (click.action === "cancel") {
    if (!deps.store.claimProposal(row.id, ["open"], "cancelled")) {
      await movedOn(deps, spec, click.ui, row);
      return;
    }
    deps.log(`proposal ${row.id}: cancelled by ${click.userId}`);
    await drawOutcome(deps, spec, click.ui, row.id);
    return;
  }

  // Create and retry: the claim is the approval. False is a double click, a late
  // click on a finished card, or a cancel that got there first, and none of them
  // writes anything.
  if (!deps.store.claimProposal(row.id, ["open"], "applying")) {
    await movedOn(deps, spec, click.ui, row);
    return;
  }

  // The interim card says the click was taken. It is a courtesy: an apply that is
  // going to fail still runs.
  await redraw(deps, spec, click.ui, { ...row, status: "applying" });
  try {
    await spec.apply(row, (progress) => deps.store.updateProposal(row.id, { progress }));
    deps.store.updateProposal(row.id, { status: "done", error: null });
  } catch (err) {
    const reason = errMessage(err);
    // Back to open, so the card keeps its buttons and the next click retries
    // from the progress the writes recorded, not from nothing.
    deps.store.updateProposal(row.id, { status: "open", error: reason });
    // The reason is not in this line: a kind's failures can name what it was writing
    // (an Account option is a customer), and the kind already logs its own detail.
    // The card, which is ZY's own view, is where the reason belongs.
    deps.log(`proposal ${row.id}: apply failed`);
  }
  await drawOutcome(deps, spec, click.ui, row.id);
}

/**
 * The Edit modal's submit: the spec turns the values into a payload, and the
 * store takes it only from the revision the modal was opened on.
 */
export async function proposalEdited(deps: ProposalDeps, edit: ProposalEdit): Promise<void> {
  if (edit.userId !== deps.userId) return;

  const row = deps.store.findProposal(edit.id);
  if (row === null) {
    deps.log(`proposal ${edit.id}: unknown, this edit does nothing`);
    return;
  }
  const spec = deps.specs[row.kind];
  if (spec === undefined) {
    deps.log(`proposal ${row.id}: kind ${row.kind} is not one this bot applies, this edit does nothing`);
    return;
  }
  if (spec.edited === undefined) {
    deps.log(`proposal ${row.id}: kind ${row.kind} cannot be edited, this edit does nothing`);
    return;
  }

  // An edit the kind refuses is refused here, before it is stored: its own words
  // go back to ZY, and the card is drawn again exactly as it was.
  let payload: string;
  try {
    payload = spec.edited(row, edit.values);
  } catch (err) {
    const reason = errMessage(err);
    deps.log(`proposal ${row.id}: the edit was refused: ${reason}`);
    await announce(deps, edit.ui, row.id, reason);
    await redraw(deps, spec, edit.ui, row);
    return;
  }

  // The rev is the card the modal was opened on: an edit from a card that has
  // been applied or cancelled in between is too late, and stores nothing. The
  // reply never says which of the two it was: an apply in flight is neither, and
  // a submit that lost the race cannot tell them apart anyway.
  if (!deps.store.editProposal(row.id, edit.rev, payload)) {
    const now = reread(deps, row);
    await announce(deps, edit.ui, row.id, "this card has moved on: nothing was changed");
    if (now.status === "done" || now.status === "cancelled") await redraw(deps, spec, edit.ui, now);
    return;
  }

  deps.log(`proposal ${row.id}: edit rev ${edit.rev} by ${edit.userId}`);
  const now = reread(deps, row);
  const card = spec.card(now);
  if (await attempt(deps, `proposal ${row.id}: the redraw failed`, () => edit.ui.redraw(card, now.rev))) return;
  // The old message cannot be edited any more: the same card is posted afresh,
  // which is the clickable one from here on.
  await attempt(deps, `proposal ${row.id}: the repost failed`, () => edit.ui.repost(card, now.rev));
}
