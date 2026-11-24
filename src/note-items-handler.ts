// 0.8.0's note items, on the proposal machinery: the propose step that records
// the row and posts the card, and the Apply that writes the batch. The pure parts
// — which items the note has, the card in every state, the edit — are
// note-items.ts; one item's four writes are add:'s createItem, so a batch item and
// a DM item stop and resume the same way and a retry never makes a second issue.
//
// Nothing here talks to Slack, GitHub or a model: the board, the store, the clock
// and the ui are passed in, so a click in a test goes through the path Slack
// drives. The note is committed before any of this runs, which is why a failure
// has no ack to edit and no draft to fall back on: the row is cancelled with its
// reason and the thread says it once.
//
// A batch is not one item: an item that fails does not stop the ones after it, so
// what the card offers is a retry that continues from whichever items are left.

import { addContext, issueBody, type AddContext } from "./add.ts";
import { createItem, planOf, type FailedStep } from "./add-handler.ts";
import { errMessage } from "./errors.ts";
import type { BoardSource, IssueWriter } from "./github.ts";
import {
  draftOf,
  finished,
  itemsToCreate,
  noteItems,
  noteItemsCard,
  noteItemsEditFields,
  payloadFromEdit,
  readNoteItemsContext,
  readNoteItemsPayload,
  readNoteItemsProgress,
  validatePayload,
  type NoteItemsPayload,
  type NoteItemsState,
} from "./note-items.ts";
import type { Card, ProposalSpec } from "./proposals.ts";
import { oneLine, type Note } from "./scribe.ts";
import type { Proposal, ProposalStore } from "./store.ts";
import { localNow, TZ } from "./time.ts";

/** The prefix of a proposal id, so a redelivery and a retry land on the same row. */
const ID_PREFIX = "note:";

/** The kind of a note's proposal: the id's prefix, and the key this spec is registered under. */
const KIND = "note";

/** How much of a failure the card repeats, and the log line with it. */
const ERROR_MAX = 200;

/** One committed note whose actions become board items: what the card is about. */
export interface NoteItemsInput {
  ts: string; // the dictation's ts: the proposal is `note:<ts>`
  channel: string; // where the card goes: what a restart's redraw needs to find it again
  folder: string; // the folder the note was actually committed to, resolved
  note: Note; // includes actions and date
  url: string; // the commit url
}

/** What the propose step works against: the board, the store, where items go, and the clock. */
export interface NoteItemsDeps {
  board: BoardSource & IssueWriter;
  proposals: ProposalStore;
  repo: string; // ADD_REPO: where Create makes the issues
  owner: string;
  number: number;
  now: () => Date;
  log: (line: string) => void;
}

/** How the propose step talks to Slack: the card it posts, and the thread's follow-ups. */
export interface NoteItemsUi {
  /** Posts the card and returns the message's ts; it is the card later clicks and edits find. */
  post(card: Card, rev: number): Promise<string>;
  /** A follow-up message in the same thread, for what the card cannot say. */
  reply(text: string): Promise<void>;
}

/** The proposal id of a dictation: the dedupe, and what a click rebuilds the kind from. */
export function noteItemsProposalId(ts: string): string {
  return `${ID_PREFIX}${ts}`;
}

/** The ts a proposal id was made from: what a log line names, and never a title. */
function tsOf(id: string): string {
  return id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id;
}

/** A row whose stored items or board facts cannot be read: no card to write from and no modal. */
const UNREADABLE = "this note's items could not be read";

/**
 * Why a step failed, short enough for one card line and for the log. A GitHub
 * refusal carries up to 200 characters of the response body, and that body can
 * quote the title the request sent: a `GitHub API <status>` failure keeps its
 * status and drops the body, and anything longer is clipped.
 */
function shortReason(err: unknown): string {
  const message = oneLine(errMessage(err));
  const api = /^(GitHub API \d+):/.exec(message);
  const reason = api === null ? message : api[1];
  return reason.length <= ERROR_MAX ? reason : `${reason.slice(0, ERROR_MAX).trimEnd()}…`;
}

/**
 * The row as the card and a click read it: the stored JSON, plus what this
 * deployment settles. The progress is handed on as it read: null says it could
 * not be read, and applyNoteItems is where that stops a click.
 */
function stateOf(proposal: Proposal, deps: NoteItemsDeps): NoteItemsState {
  const progress = readNoteItemsProgress(proposal.progress);
  return {
    status: proposal.status,
    payload: readNoteItemsPayload(proposal.payload),
    context: readNoteItemsContext(proposal.context),
    progress,
    // A progress that exists but cannot be read has items in it that cannot be
    // adopted: the card must say so instead of offering a Create that would
    // write them twice.
    progressUnreadable: progress === null && proposal.progress !== null,
    error: proposal.error,
    repo: deps.repo,
  };
}

/**
 * The payload and the board facts of a row, or the throw that stops a click
 * before it writes: a row with half of the pair (written by another version) is
 * no card to draw, to edit or to write from.
 */
function readable(proposal: Proposal): { payload: NoteItemsPayload; context: AddContext } {
  const payload = readNoteItemsPayload(proposal.payload);
  const context = readNoteItemsContext(proposal.context);
  if (payload === null || context === null) throw new Error(UNREADABLE);
  return { payload, context };
}

/**
 * A proposal that ends before it has a card. The note is committed already, so
 * there is no ack to edit: the row carries the reason a redraw of it says, and
 * the thread says it once.
 */
async function stop(deps: NoteItemsDeps, id: string, ts: string, ui: NoteItemsUi, what: string, reason: string): Promise<void> {
  deps.log(`note-items ${ts}: ${what}: ${reason}`);
  deps.proposals.updateProposal(id, { status: "cancelled", error: reason });
  try {
    await ui.reply(`⚠️ could not propose board items: ${reason}`);
  } catch (err) {
    // A thread that will not take the line changes nothing: the row already says why.
    deps.log(`note-items ${ts}: the reply failed: ${errMessage(err)}`);
  }
}

/**
 * One committed note's actions, proposed as one card: the row first (so a
 * redelivery is harmless), then the board, the items, and the card on it. A
 * failure before the card cancels the row with its reason instead of waiting for
 * a click that will never come.
 */
export async function proposeNoteItems(deps: NoteItemsDeps, input: NoteItemsInput, ui: NoteItemsUi): Promise<void> {
  const id = noteItemsProposalId(input.ts);
  // The stored row is the dedupe: a redelivery, a scribe Retry and a restart's
  // propagation of one note all land on it. The source is the note's link: the
  // note's own words are committed, and the link is what this row keeps of them.
  const recorded = deps.proposals.recordProposal({ id, kind: KIND, source: input.url, createdAt: deps.now().toISOString() });
  if (!recorded) {
    deps.log(`note-items ${input.ts}: already proposed, ignoring`);
    return;
  }

  // Today is only what the items are judged against. The note's own date is the
  // meeting's, and the payload keeps it: an issue made from it says that day.
  const today = localNow(deps.now(), TZ).date;
  let context: AddContext;
  try {
    context = addContext(await deps.board.fetchBoard(deps.owner, deps.number));
  } catch (err) {
    await stop(deps, id, input.ts, ui, "the board read failed", errMessage(err));
    return;
  }

  let payload: NoteItemsPayload;
  try {
    // The folder the note was committed to is the one that names the account,
    // whatever the note's own field says: a new folder, or ZY's pick, is not the
    // model's answer, and it is where the note went.
    payload = validatePayload(noteItems({ ...input.note, folder: input.folder }, context, input.url, today), context, today);
  } catch (err) {
    // A payload the board cannot take is a card that cannot work: no click is
    // offered on it, and the reason names a field rather than an option.
    await stop(deps, id, input.ts, ui, "the payload was refused", errMessage(err));
    return;
  }

  deps.proposals.updateProposal(id, {
    payload: JSON.stringify(payload),
    context: JSON.stringify(context),
    status: "open",
    error: null,
  });
  const row = deps.proposals.findProposal(id);
  if (row === null) {
    deps.log(`note-items ${input.ts}: the row is gone, there is no card to post`);
    return;
  }
  // The card is drawn from the row, not from what was just computed: what a click
  // later redraws is the same card, and the rev is the row's own.
  let messageTs: string;
  try {
    messageTs = await ui.post(noteItemsCard(stateOf(row, deps)), row.rev);
  } catch (err) {
    await stop(deps, id, input.ts, ui, "the card failed to post", errMessage(err));
    return;
  }
  // The ts is what a restart's redraw and a later click need, and the channel is
  // where the card is: the store keeps both, so a restart finds it again. A store
  // that cannot take them costs only that, and is never a proposal that failed:
  // the card is up, and saying it was not proposed would contradict it.
  try {
    deps.proposals.updateProposal(id, { channel: input.channel, messageTs });
  } catch (err) {
    deps.log(`note-items ${input.ts}: the card's ts could not be stored: ${errMessage(err)}`);
    return;
  }

  const skip = payload.items.filter((item) => item.as === "skip").length;
  // One line per proposal, ids only: no title, no owner, no account, no folder.
  deps.log(`note-items ${input.ts}: proposed ${payload.items.length} items (${skip} not created, parent ${payload.parentRef ?? "none"})`);
}

/**
 * One note's Create: every item's four writes, in the note's order, each saved as
 * it lands. A failed item does not stop the batch — the items after it are still
 * worth making — and the throw at the end is what reopens the card with Retry.
 */
async function applyNoteItems(deps: NoteItemsDeps, proposal: Proposal, save: (progress: string) => void): Promise<void> {
  const ts = tsOf(proposal.id);
  // Before the board read and before any write: there is nothing to write without both.
  const { payload } = readable(proposal);
  // An empty progress says nothing was written, so one that cannot be read is a
  // stop, not a second issue for every item.
  const progress = readNoteItemsProgress(proposal.progress);
  if (progress === null) throw new Error("this proposal's progress could not be read");
  // A fresh read on every attempt: the ids, the options and the parent are the
  // board's as it is now, never the snapshot the card was drawn from.
  const board = await deps.board.fetchBoard(deps.owner, deps.number);

  const writing = itemsToCreate(payload);
  // An item nothing has written yet is checked here, before an issue exists: a
  // name the board has since dropped must not orphan an issue for it. An item a
  // failed click already began resolves only what it has left, just before it
  // writes: stopping the whole retry for a name that is behind it would trap it.
  for (const [k, one] of writing.entries()) {
    const started = progress.items[k];
    if (started !== undefined && (started.issue !== undefined || started.issuePending !== undefined)) continue;
    planOf(draftOf(one.item, payload), board);
  }
  // One entry per item written, so the batch saves as a whole array: a hole in it
  // reads back as a progress nobody can read, which would stop every later retry.
  writing.forEach((_, k) => {
    if (progress.items[k] === undefined) progress.items[k] = { error: null };
  });

  // createItem saves one item's steps, one at a time; the row holds the whole
  // batch, so each of those saves is the batch's JSON.
  const saveBatch = (): void => save(JSON.stringify(progress));

  let created = 0;
  let failed = 0;
  for (const [k, { index, item }] of writing.entries()) {
    // The card's number, which is what a person reads the log next to; the marker
    // below is a write's own sequence, which is not the same when items are skipped.
    const n = index + 1;
    const entry = progress.items[k];
    // An item an earlier click finished is adopted, not written again: the card's
    // own predicate decides, so the head and this loop cannot disagree.
    if (finished(entry, payload.parentRef)) continue;
    // A previous attempt's reason is not this attempt's: the steps it has left
    // decide that, and a card must not keep showing a failure that is now over.
    entry.error = null;

    // Two digits, because findIssue matches with includes: one item's marker is
    // never the start of another's. The ts is the proposal's, never a title.
    const marker = `note:${ts}/${String(k + 1).padStart(2, "0")}`;
    const fail = (step: FailedStep, err: unknown): never => {
      const reason = shortReason(err);
      entry.error = reason;
      saveBatch();
      // The step and the reason only: a reason that is a GitHub body is clipped to
      // its status above, because that body can echo the title the request sent.
      deps.log(`note-items ${ts}: item ${n}: failed at ${step}: ${reason}`);
      throw err;
    };

    try {
      const made = await createItem(deps, {
        board,
        draft: draftOf(item, payload),
        progress: entry,
        save: saveBatch,
        marker,
        // The note's own date, not the day of the click: the issue says what day
        // the meeting was, and the body quotes the note's line as it committed it.
        body: issueBody(item.line, payload.note.date, marker, `a meeting note (${payload.note.url})`),
        fail,
      });
      created += 1;
      deps.log(`note-items ${ts}: item ${n}: created ${deps.repo}#${made.issue.number} as ${made.itemId}, under ${made.parentItemId ?? "none"}`);
    } catch (err) {
      // A reason fail() already set was logged and saved there, and is not said
      // twice. Anything else that got here — the board read a failed addToProject
      // falls back to, most of all — is still this item's failure: it is saved and
      // logged, because a card must not show an item as made whose step threw.
      if (entry.error === null) {
        const reason = shortReason(err);
        entry.error = reason;
        saveBatch();
        deps.log(`note-items ${ts}: item ${n}: failed: ${reason}`);
      }
      // The items after this one still run.
      failed += 1;
    }
  }

  // The batch's own count, this run's: a retry's line says how much of the note it
  // had left to make, which is the number a person cannot work out from the rest.
  deps.log(`note-items ${ts}: created ${created} of ${writing.length}`);
  if (failed > 0) throw new Error(`${failed} of ${writing.length} items failed`);
}

/** The `note:` kind: how a card is drawn, how the items are edited, and what Create writes. */
export function noteItemsSpec(deps: NoteItemsDeps): ProposalSpec {
  return {
    card: (proposal) => noteItemsCard(stateOf(proposal, deps)),

    // A row whose items or board facts cannot be read has no inputs to open: the
    // throw is logged by the click and no modal is shown, which is the only way
    // it cannot write.
    editFields: (proposal) => {
      const { payload, context } = readable(proposal);
      return noteItemsEditFields(payload, context);
    },

    edited: (proposal, values) => {
      const { payload, context } = readable(proposal);
      // The edit is checked exactly as the note's own actions were: an impossible
      // one is refused here, and its message is the refusal ZY reads.
      return JSON.stringify(payloadFromEdit(payload, values, context, localNow(deps.now(), TZ).date));
    },

    apply: (proposal, save) => applyNoteItems(deps, proposal, save),
  };
}
