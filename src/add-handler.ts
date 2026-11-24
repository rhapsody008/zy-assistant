// The `add:` pipeline and its Apply: one sentence from the DM in, one board item
// out. The model drafts it, the card is the approval, and what Create writes is
// the only thing in here that touches GitHub.
//
// The sentence is never lost. It is stored as the proposal before any model is
// asked, and a model that cannot answer still leaves a card, with the sentence
// itself as its title. What a failed board read costs is the card: the sentence
// is stored and the ack carries the reason, and the row stays drafting until a
// restart cancels it, when the startup redraw puts that stopped draft's card in
// the ack's place. Nothing is written for a row like that.
//
// Every write of an Apply is saved to the proposal's progress before the next one
// starts, so a retry continues from where the failure left off and never creates
// a second issue. The draft holds option NAMES and a parent's ref, never an id:
// while nothing is written, Apply resolves them all against the board as it is at
// the click and checks them before it creates anything, so a draft written against
// a board that has since changed fails with nothing written rather than leaving a
// stray issue. Once the issue exists, each step resolves only what it still has to
// write: an option renamed afterwards must not trap a retry forever.

import {
  addCard,
  addContext,
  addEditFields,
  addSystemPrompt,
  addUserPrompt,
  draftFromEdit,
  fallbackDraft,
  issueBody,
  readContext,
  readPayload,
  readProgress,
  UNREADABLE_DRAFT,
  validateDraft,
  type AddContext,
  type AddDraft,
  type AddPayload,
  type AddState,
} from "./add.ts";
import { errMessage } from "./errors.ts";
import type { Board, BoardField, BoardSource, IssueWriter } from "./github.ts";
import { completeJson, type Llm } from "./llm.ts";
import type { Card, ProposalSpec } from "./proposals.ts";
import { FIELD } from "./schema.ts";
import type { Proposal, ProposalStore } from "./store.ts";
import { localNow, TZ } from "./time.ts";

/** The reply that becomes the card: what ZY sees while the model works. */
const ACK = "✍️ drafting…";

/** The prefix of a proposal id, so a retry and a redelivery land on the same row. */
const ID_PREFIX = "add:";

/** Where a write failed: what the log line says a retry continues from. */
type FailedStep = "issue" | "project" | "fields" | "link";

/** Where a sentence was typed when it was a reply: the item its thread is about. */
export interface AddHint {
  ref: string;
  title: string;
}

/** One `add: ...` DM. */
export interface AddInput {
  ts: string;
  text: string;
  hint: AddHint | null;
}

/** The proposal id of a message: the dedupe, and what the Slack side rebuilds from a click. */
export function proposalId(ts: string): string {
  return `${ID_PREFIX}${ts}`;
}

export interface AddDeps {
  llm: Llm;
  board: BoardSource & IssueWriter;
  proposals: ProposalStore;
  repo: string; // ADD_REPO: where the issue is created
  owner: string;
  number: number;
  now: () => Date;
  log: (line: string) => void;
  timeoutMs: number; // the model's budget
  maxTokens: number;
}

/** How the pipeline talks to Slack: the drafting reply, its failure, and the card. */
export interface AddUi {
  reply(text: string): Promise<{ channel: string; ts: string }>;
  /** Edits that message to a plain line: what a failure before the card looks like. */
  edit(channel: string, ts: string, text: string): Promise<void>;
  /** Edits it into the card. */
  card(channel: string, ts: string, card: Card, rev: number): Promise<void>;
}

/** The ts a proposal id was made from: what a log line names, and never the sentence. */
function tsOf(id: string): string {
  return id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id;
}

/** The one line addUserPrompt appends, or null: `<ref> "<title>"`. */
function hintLine(hint: AddHint | null): string | null {
  return hint === null ? null : `${hint.ref} "${hint.title}"`;
}

/**
 * The row as the card and the Edit modal read it: the stored JSON, plus what this deployment settles.
 * A progress that cannot be read is drawn as none: a card has to say something, and
 * applyAdd is where an unreadable progress stops a click.
 */
function stateOf(proposal: Proposal, deps: AddDeps): AddState {
  return {
    payload: readPayload(proposal.payload),
    context: readContext(proposal.context),
    sentence: proposal.source,
    repo: deps.repo,
    rev: proposal.rev,
    status: proposal.status,
    progress: readProgress(proposal.progress) ?? {},
    error: proposal.error,
  };
}

/**
 * The payload and the context of a row, or the throw that stops a click before
 * it writes: a row with half of the pair (written by another version) is no
 * draft to draw, to edit or to write from.
 */
function readableDraft(proposal: Proposal): { payload: AddPayload; context: AddContext } {
  const payload = readPayload(proposal.payload);
  const context = readContext(proposal.context);
  if (payload === null || context === null) throw new Error(UNREADABLE_DRAFT);
  return { payload, context };
}

/** An edit of the ack that Slack may refuse: the failure is already said, and never thrown out. */
async function editQuietly(deps: AddDeps, ui: AddUi, ts: string, at: { channel: string; ts: string }, text: string): Promise<void> {
  try {
    await ui.edit(at.channel, at.ts, text);
  } catch (err) {
    deps.log(`add ${ts}: the edit failed: ${errMessage(err)}`);
  }
}

/**
 * The model's one answer, or the sentence as the draft. A model that cannot
 * answer is not a lost sentence: the fallback card is one click away from the
 * same item, and says why it is only words.
 */
async function draftPayload(deps: AddDeps, input: AddInput, context: AddContext, today: string): Promise<AddPayload> {
  try {
    const draft = await completeJson(
      deps.llm,
      {
        system: addSystemPrompt(today, context),
        user: addUserPrompt(input.text, hintLine(input.hint)),
        maxTokens: deps.maxTokens,
        timeoutMs: deps.timeoutMs,
      },
      (value) => validateDraft(value, context, today),
    );
    return { draft, modelError: null };
  } catch (err) {
    // The reason can carry the sentence's own words: V8's JSON.parse message
    // quotes the reply. It reaches the card, which is ZY's view, and never the log.
    deps.log(`add ${input.ts}: the model failed, the draft is the sentence`);
    return { draft: fallbackDraft(input.text), modelError: errMessage(err) };
  }
}

/** One `add: ...` DM: dedupe, ack, board, draft, then the card on that same message. */
export async function addHandler(deps: AddDeps, input: AddInput, ui: AddUi): Promise<void> {
  const id = proposalId(input.ts);
  const startedAt = deps.now().getTime();
  // The stored row is the dedupe: Slack redelivers, and a second socket answers too.
  if (!deps.proposals.recordProposal({ id, kind: "add", source: input.text, createdAt: deps.now().toISOString() })) {
    deps.log(`add ${input.ts}: already taken, ignoring the redelivery`);
    return;
  }

  let ack: { channel: string; ts: string };
  try {
    ack = await ui.reply(ACK);
  } catch (err) {
    // Nowhere to say anything: the row stays drafting, and a restart cancels it.
    deps.log(`add ${input.ts}: the ack failed: ${errMessage(err)}`);
    return;
  }
  // Where the card goes is known before the draft is, so a failure still has a message to be said on.
  deps.proposals.updateProposal(id, { channel: ack.channel, messageTs: ack.ts });

  const today = localNow(deps.now(), TZ).date;
  let context: AddContext;
  try {
    context = addContext(await deps.board.fetchBoard(deps.owner, deps.number));
  } catch (err) {
    const reason = errMessage(err);
    deps.log(`add ${input.ts}: the board read failed: ${reason}`);
    // The row ends here, not at the next restart: no draft was stored, so a redraw
    // of it must say what went wrong rather than that it could not be read.
    deps.proposals.updateProposal(id, { status: "cancelled", error: reason });
    await editQuietly(deps, ui, input.ts, ack, `⚠️ could not read the board: ${reason}`);
    return;
  }

  const payload = await draftPayload(deps, input, context, today);
  try {
    deps.proposals.updateProposal(id, { payload: JSON.stringify(payload), context: JSON.stringify(context), error: null });
    // The claim is the draft's: a run that lost the row to another one draws no second card over it.
    if (!deps.proposals.claimProposal(id, ["drafting"], "open")) {
      deps.log(`add ${input.ts}: another run took the draft, not drawing it`);
      return;
    }
    const row = deps.proposals.findProposal(id);
    if (row === null) {
      deps.log(`add ${input.ts}: the row is gone, there is no card to draw`);
      return;
    }
    await ui.card(ack.channel, ack.ts, addCard(stateOf(row, deps)), row.rev);
  } catch (err) {
    const reason = errMessage(err);
    deps.log(`add ${input.ts}: drafting failed: ${reason}`);
    await editQuietly(deps, ui, input.ts, ack, `⚠️ could not draft the item: ${reason}`);
    return;
  }
  // One line per draft, ids only: no sentence, no title, no option.
  deps.log(`add ${input.ts}: drafted in ${deps.now().getTime() - startedAt} ms (parent ${payload.draft.parentRef ?? "none"})`);
}

// ---- Apply ------------------------------------------------------------------

/** One field write, resolved against the board as the click finds it: no id is ever stored. */
type FieldWrite =
  | { kind: "single"; fieldId: string; optionId: string }
  | { kind: "date"; fieldId: string; date: string }
  | { kind: "text"; fieldId: string; text: string };

/** What the pre-flight resolves while nothing is written: the field writes, and the issue to hang the new one under. */
interface AddPlan {
  fields: FieldWrite[];
  parent: { itemId: string; contentId: string } | null;
}

/** A board field by the name a person sees, or a throw that names it. */
function fieldOf(board: Board, name: string): BoardField {
  const field = board.fields.get(name);
  if (field === undefined) throw new Error(`the board has no ${name} field`);
  return field;
}

function selected(board: Board, name: string, option: string | null): FieldWrite | null {
  if (option === null) return null;
  const field = fieldOf(board, name);
  const optionId = field.options?.get(option);
  // The value is never in the message: an Account option is a customer's name,
  // and this throw reaches the card and the log line a click leaves behind.
  if (optionId === undefined) throw new Error(`the board has no ${name} option the draft names`);
  return { kind: "single", fieldId: field.id, optionId };
}

function dated(board: Board, name: string, date: string | null): FieldWrite | null {
  return date === null ? null : { kind: "date", fieldId: fieldOf(board, name).id, date };
}

function written(board: Board, name: string, text: string | null): FieldWrite | null {
  return text === null ? null : { kind: "text", fieldId: fieldOf(board, name).id, text };
}

/** The engagement the draft names, as the board has it now: an item that is an issue, or a throw. */
function plannedParent(board: Board, ref: string): { itemId: string; contentId: string } {
  const item = board.items.find((one) => one.ref === ref);
  if (item === undefined) throw new Error(`parent ${ref} is not on the board`);
  // A draft and a pull request have no issue to hang a sub-issue on.
  if (item.contentId === null) throw new Error(`parent ${ref} is not an issue on the board`);
  return { itemId: item.id, contentId: item.contentId };
}

/**
 * Everything the draft names, resolved against the board: every field it sets
 * has to be there still, with that option, and its parent has to be an issue.
 * A throw here happens before createIssue, so a stale draft leaves no issue. The
 * two halves are also resolved on their own, by a retry whose issue already
 * exists and whose stale names must not stop it finishing.
 */
function planOf(draft: AddDraft, board: Board): AddPlan {
  return {
    fields: planFields(draft, board),
    parent: draft.parentRef === null ? null : plannedParent(board, draft.parentRef),
  };
}

/** The field writes the draft names, in board order: each one resolved or a throw. */
function planFields(draft: AddDraft, board: Board): FieldWrite[] {
  return [
    selected(board, FIELD.status, draft.status),
    selected(board, FIELD.track, draft.track),
    selected(board, FIELD.account, draft.account),
    selected(board, FIELD.type, draft.workType),
    dated(board, FIELD.target, draft.targetDate),
    dated(board, FIELD.nextTouch, draft.nextTouch),
    written(board, FIELD.nextAction, draft.nextAction),
  ].filter((write): write is FieldWrite => write !== null);
}

/** One resolved field write: the ids were all found on the board as the step that writes them read it. */
function writeField(board: BoardSource & IssueWriter, projectId: string, itemId: string, write: FieldWrite): Promise<void> {
  switch (write.kind) {
    case "single":
      return board.setSingleSelect(projectId, itemId, write.fieldId, write.optionId);
    case "date":
      return board.setDate(projectId, itemId, write.fieldId, write.date);
    case "text":
      return board.setText(projectId, itemId, write.fieldId, write.text);
  }
}

/**
 * The writes behind Create, continuing from whatever progress already has: the
 * issue, its board item, its fields, and the link under its engagement. Each
 * step is saved before the next one starts, so the card's retry knows where a
 * failure stopped and writes no second issue.
 */
async function applyAdd(deps: AddDeps, proposal: Proposal, save: (progress: string) => void): Promise<void> {
  const ts = tsOf(proposal.id);
  // Before the board read and before any write: there is nothing to resolve without both.
  const { payload } = readableDraft(proposal);
  const draft = payload.draft;
  // {} would say nothing was written, so a progress that cannot be read is a stop,
  // not a second issue.
  const progress = readProgress(proposal.progress);
  if (progress === null) throw new Error("this draft's progress could not be read");
  // A fresh read on every attempt: the ids, the options and the parent are the
  // board's as it is now, never the snapshot the draft was drawn from.
  const board = await deps.board.fetchBoard(deps.owner, deps.number);
  // Nothing has been written yet, so every name is checked here, before an issue
  // exists. Once one does, a name the board has since dropped must not stop the
  // retry: the steps that are left resolve their own names just before they write.
  if (progress.issue === undefined && progress.issuePending === undefined) planOf(draft, board);

  const fail = (step: FailedStep, err: unknown): never => {
    deps.log(`add ${ts}: create failed at ${step}: ${errMessage(err)}`);
    throw err;
  };

  if (progress.issue === undefined) {
    // The marker is saved before the POST: if the POST landed while its answer did
    // not, the issue is found here and adopted instead of written a second time.
    if (progress.issuePending !== undefined) {
      try {
        const found = await deps.board.findIssue(deps.repo, progress.issuePending);
        if (found !== null) {
          progress.issue = found;
          delete progress.issuePending; // named now, so nothing has to look it up again
          save(JSON.stringify(progress));
        }
      } catch (err) {
        return fail("issue", err);
      }
    }
    if (progress.issue === undefined) {
      progress.issuePending = proposal.id;
      save(JSON.stringify(progress));
      // The day ZY typed it, not the day of the retry: the issue says when it came from Slack.
      const added = localNow(new Date(proposal.createdAt), TZ).date;
      try {
        progress.issue = await deps.board.createIssue(deps.repo, draft.title, issueBody(proposal.source, added, proposal.id));
      } catch (err) {
        return fail("issue", err);
      }
      delete progress.issuePending; // named now, so nothing has to look it up again
      save(JSON.stringify(progress));
    }
  }
  const issue = progress.issue;

  if (progress.itemId === undefined) {
    try {
      progress.itemId = await deps.board.addToProject(board.projectId, issue.id);
    } catch (err) {
      // A project workflow may have added the issue first: it is on the board
      // then, and that item is the one to write. Only when it is not does the
      // failure stand, with the issue already recorded for the retry.
      const again = await deps.board.fetchBoard(deps.owner, deps.number);
      const found = again.items.find((item) => item.contentId === issue.id);
      if (found === undefined) return fail("project", err);
      progress.itemId = found.id;
    }
    save(JSON.stringify(progress));
  }
  const itemId = progress.itemId;

  if (progress.fields === undefined) {
    try {
      // All of them, every time: a retry after a half-written item rewrites what
      // is already set, which is the same write twice and never a different one.
      for (const write of planFields(draft, board)) await writeField(deps.board, board.projectId, itemId, write);
    } catch (err) {
      return fail("fields", err);
    }
    progress.fields = true;
    save(JSON.stringify(progress));
  }

  // The item the issue hangs under, for the last line: the write below resolves it
  // itself, and a retry that finds it already linked only looks it up.
  let parentItemId: string | null = null;
  if (draft.parentRef !== null) {
    if (progress.linked === undefined) {
      try {
        const parent = plannedParent(board, draft.parentRef);
        await deps.board.addSubIssue(parent.contentId, issue.id);
        parentItemId = parent.itemId;
      } catch (err) {
        return fail("link", err);
      }
      progress.linked = true;
      save(JSON.stringify(progress));
    } else {
      parentItemId = board.items.find((item) => item.ref === draft.parentRef)?.id ?? null;
    }
  }

  // One line per created item, ids only: no title, no sentence, no option.
  deps.log(`add ${ts}: created ${deps.repo}#${issue.number} as ${itemId}, under ${parentItemId ?? "none"}`);
}

/** The `add:` kind: how a card is drawn, how the draft is edited, and what Create writes. */
export function addSpec(deps: AddDeps): ProposalSpec {
  return {
    card: (proposal) => addCard(stateOf(proposal, deps)),

    // A row whose draft cannot be read has no inputs to open: the throw is logged
    // by the click and no modal is shown, which is the only way it cannot write.
    editFields: (proposal) => {
      const { payload, context } = readableDraft(proposal);
      return addEditFields(payload.draft, context);
    },

    edited: (proposal, values) => {
      const { payload, context } = readableDraft(proposal);
      const today = localNow(deps.now(), TZ).date;
      // The edit is checked exactly as the model's answer was: an impossible one
      // is refused here, and its message is the refusal ZY reads.
      return JSON.stringify({ draft: draftFromEdit(payload.draft, values, context, today), modelError: null });
    },

    apply: (proposal, save) => applyAdd(deps, proposal, save),
  };
}
