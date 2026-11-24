// The pure core of 0.8.0's note items: once the scribe has committed a meeting
// note, the note's own actions become ONE proposal that covers up to six board
// items. No I/O and no clock in here: the note, the board facts, the note's link
// and today's date are passed in, so what the card is drawn from, the card in
// every state and an edit are testable without a model, GitHub or Slack.
//
// The writes behind the card are add:'s: the same four steps per item, each with
// its own progress, so a retry continues from the item it stopped at and never
// makes a second issue for one it made already. What this file owns is the
// judgement no model is asked for: whose day a date is, which owner is ZY, and
// what the board already has.
//
// A note's action is `- [ ] <owner>: <text> (due <date>)`. ZY's own action is a
// target he owes; anyone else's is a touch, the day he chases it. That is a
// decided product rule and not a reading of the sentence: the deadline rules
// must never nag ZY for another person's deliverable.

import { escapeData } from "./ask.ts";
import {
  edited,
  ERRORS as reasonOf,
  FAILED_STEP,
  parse,
  readContext,
  readProgressValue,
  selectOf,
  stored,
  TITLE_MAX,
  unfinishedStep,
  validateDraft,
  type AddContext,
  type AddDraft,
  type AddProgress,
} from "./add.ts";
import { errMessage } from "./errors.ts";
import type { Card, EditField, ProposalButton } from "./proposals.ts";
import { STATUS } from "./schema.ts";
import { oneLine, type Note, type NoteAction } from "./scribe.ts";
import type { ProposalStatus } from "./store.ts";
import { dayDiff, fmtDate } from "./time.ts";

/** The card's own name for the batch: every state of it is a state of this. */
const HEAD = "*Board items from this note*";

/** Six items is what one card holds beside its context: more is one `add:` at a time. */
const ITEMS_MAX = 6;

/** The notes repo's customer root: the only folder that names an Account option. */
const ACCOUNTS = "Accounts/";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Cut to `max` characters: what a model wrote longer than the field allows. */
function clipped(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max).trimEnd();
}

/** What an item becomes on the board, or nothing at all. */
type ItemAs = "next" | "waiting" | "skip";

/** The `as` values an edit modal offers, and the only three an item can be. */
const AS_OPTIONS = [
  { label: "Next", value: "next" },
  { label: "Waiting", value: "waiting" },
  { label: "Don't create", value: "skip" },
];

/**
 * The three values an item's `as` may be, read off what was stored or submitted:
 * anything else is no item rather than a `next` by guess.
 */
function asOfValue(value: unknown): ItemAs | null {
  return value === "next" || value === "waiting" || value === "skip" ? value : null;
}

/** One action of a note, as the card would write it. */
export interface NoteItem {
  title: string; // the action text, verbatim, clipped to TITLE_MAX
  owner: string; // as the note names them; "ZY" when it is ZY
  as: ItemAs;
  due: string | null; // YYYY-MM-DD, or null when the note's date was in the past
  line: string; // the action line as the note holds it, for the issue body
  flag: null | { kind: "past-due" } | { kind: "already-there"; ref: string };
}

/** One reason an action is not written: a past date, or a board item that is there already. */
type NoteFlag = NoteItem["flag"];

/** What the card is drawn from, and what Create writes. Nothing here is an id. */
export interface NoteItemsPayload {
  v: 1;
  note: { date: string; url: string; folder: string | null };
  account: string | null;
  track: string | null;
  parentRef: string | null; // an Engagement.ref, or null: standalone items
  candidates: number; // open engagements for that account: more than one is what the card warns about
  items: NoteItem[];
  more: number; // actions of the note beyond the six this card holds
}

/** What Create has written so far, so a retry never writes the same item twice. */
export interface NoteItemsProgress {
  /** One entry per item Create writes, in itemsToCreate() order: the k-th written item is items[k]. */
  items: Array<AddProgress & { error: string | null }>;
}

/** Everything a card is drawn from. */
export interface NoteItemsState {
  status: ProposalStatus;
  payload: NoteItemsPayload | null; // null: the stored payload could not be read
  context: AddContext | null;
  progress: NoteItemsProgress | null;
  error: string | null; // the last apply failure
  /**
   * A stored progress that cannot be read. It is not the same as no progress:
   * items may already exist, so the card must not offer a Create that would write
   * them a second time.
   */
  progressUnreadable?: boolean;
  /** ADD_REPO, where Create makes the issues: the card says so before a click. */
  repo: string;
}

// ---- The note and the board -------------------------------------------------

/**
 * The account a note's folder names, or null. The folder is the account because
 * it is the one place in a note that says which customer the meeting was with,
 * and the model picks it from the notes repo's own list rather than inventing
 * it. Only `Accounts/<name>` names a customer: the repo's other roots are
 * `Partners/` and `Events/`, and neither a partner nor an event is an Account
 * option on the board.
 */
export function noteAccount(folder: string | null): string | null {
  if (folder === null || !folder.startsWith(ACCOUNTS)) return null;
  const name = folder.slice(ACCOUNTS.length);
  return name === "" || name.includes("/") ? null : name;
}

/** A name in the board's own spelling, or null: an option written in another case is still that option. */
function boardSpelling(options: string[] | null, name: string | null): string | null {
  if (options === null || name === null) return null;
  return options.find((listed) => listed.toLowerCase() === name.toLowerCase()) ?? null;
}

/**
 * Where a note's items hang: the open engagement this account already has.
 * Engagements arrive with the ones that have tasks first and then newest, so the
 * first match is the one the board itself would call current; `candidates` is how
 * many matched, which is what the card warns about when it is more than one.
 */
export function chooseParent(ctx: AddContext, account: string | null): { ref: string | null; candidates: number } {
  if (account === null) return { ref: null, candidates: 0 };
  const key = account.toLowerCase();
  const matched = ctx.engagements.filter(
    (engagement) => engagement.account !== null && engagement.account.toLowerCase() === key,
  );
  return { ref: matched[0]?.ref ?? null, candidates: matched.length };
}

/** A title as a duplicate is read: case, spacing and trailing punctuation are not what it says. */
function normalised(title: string): string {
  return oneLine(title).toLowerCase().replace(/[.,;:!?]+$/, "").trim();
}

/** The `<repo>#<n>` shape a board ref has, wherever it turns up in a sentence. */
const REF_RE = /[A-Za-z0-9._-]+#\d+/g;

/**
 * Why an action is already on the board, or null. This only sees the open
 * engagements the card was drawn with, so it misses most repeats: a finished
 * engagement's task, or another account's item, is invisible here. The card is
 * the real guard — ZY reads it before Create runs.
 */
function alreadyThere(text: string, ctx: AddContext): NoteFlag {
  for (const match of text.matchAll(REF_RE)) {
    const engagement = ctx.engagements.find((one) => one.ref === match[0]);
    if (engagement !== undefined) return { kind: "already-there", ref: engagement.ref };
  }
  const key = normalised(text);
  if (key === "") return null;
  const byTitle = ctx.engagements.find((one) => normalised(one.title) === key);
  return byTitle === undefined ? null : { kind: "already-there", ref: byTitle.ref };
}

/**
 * The action's own Markdown line, exactly as renderEntry writes it into the note.
 * The issue body quotes what the note says, so an edit changes the board item and
 * never the note: the note is committed before this card exists.
 */
function actionLine(action: NoteAction): string {
  return `- [ ] ${action.owner}: ${action.text}${action.due === null ? "" : ` (due ${action.due})`}`;
}

/** One action of the note as an item: whose it is, which day it is, and whether it is news. */
function noteItem(action: NoteAction, ctx: AddContext, today: string): NoteItem {
  const owner = action.owner.trim();
  // "ZY" is the only owner the note prompt spells, and the only person whose
  // action has a deadline of its own: anyone else's date is the day ZY chases it.
  const zy = /^zy$/i.test(owner);
  // A due date before today is a date somebody forgot to change: it is not
  // written, so no card can put a target in the past on the board.
  const past = action.due !== null && dayDiff(action.due, today) < 0;
  const there = alreadyThere(action.text, ctx);
  return {
    title: clipped(action.text, TITLE_MAX),
    owner,
    // An action whose words already name a board item is not written again; a
    // past date on one of those is nobody's problem, so the skip flag wins.
    as: there !== null ? "skip" : zy ? "next" : "waiting",
    due: past ? null : action.due,
    line: actionLine(action),
    flag: there ?? (past ? { kind: "past-due" } : null),
  };
}

/** Two actions with the same normalised title are one thing said twice: the first is kept. */
function distinct(actions: NoteAction[]): NoteAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = normalised(action.text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The payload of one note: the account its folder names, the engagement that
 * account already has, and the note's actions as items. `url` is the note's own
 * link on GitHub, which is what an issue made from it says it came from.
 */
export function noteItems(note: Note, ctx: AddContext, url: string, today: string): NoteItemsPayload {
  const account = boardSpelling(ctx.accounts, noteAccount(note.folder));
  const { ref: parentRef, candidates } = chooseParent(ctx, account);
  // Nothing infers a track from the action's words: the engagement the note is
  // about is where the item belongs, so it is the engagement's track it takes.
  const parent = parentRef === null ? null : ctx.engagements.find((one) => one.ref === parentRef) ?? null;
  const items = distinct(note.actions).map((action) => noteItem(action, ctx, today));
  const kept = items.slice(0, ITEMS_MAX);
  return {
    v: 1,
    // The folder is kept beside the link because it is what names the account:
    // a card cannot tell an Accounts/ name the board lacks from a note filed
    // outside Accounts/ without it.
    note: { date: note.date, url, folder: note.folder },
    account,
    track: parent?.track ?? null,
    parentRef,
    candidates,
    items: kept,
    // A duplicate is not an action the card leaves out: it is the same action
    // twice, so only what is past the six counts here.
    more: items.length - kept.length,
  };
}

// ---- The draft --------------------------------------------------------------

/**
 * One item as the board item Create would write. Only an item that is written has
 * a draft — itemsToCreate() is the filter — and nothing here invents a work type
 * or a next action: the note does not say them.
 */
export function draftOf(item: NoteItem, payload: NoteItemsPayload): AddDraft {
  const waiting = item.as === "waiting";
  return {
    title: item.title,
    parentRef: payload.parentRef,
    account: payload.account,
    track: payload.track,
    workType: null,
    status: waiting ? STATUS.waiting : STATUS.next,
    // ZY's own action is a target; someone else's is the day he chases them, and
    // it is that person who owes the next move.
    targetDate: waiting ? null : item.due,
    nextTouch: waiting ? item.due : null,
    nextAction: null,
    waitingOn: waiting ? item.owner : null,
  };
}

/**
 * The items Create writes, in the note's order, with the number the card gives them.
 */
export function itemsToCreate(payload: NoteItemsPayload): Array<{ index: number; item: NoteItem }> {
  return payload.items.flatMap((item, index) => (item.as === "skip" ? [] : [{ index, item }]));
}

/**
 * A draft as validateDraft reads one: the shape the sentence model replies with,
 * where the parent is `parent` because the model never sees an id. A batch has no
 * model in front of it, so it hands the checker the same shape by hand.
 */
function replyOf(draft: AddDraft): Record<string, unknown> {
  return {
    title: draft.title,
    parent: draft.parentRef,
    account: draft.account,
    track: draft.track,
    workType: draft.workType,
    status: draft.status,
    targetDate: draft.targetDate,
    nextTouch: draft.nextTouch,
    nextAction: draft.nextAction,
    waitingOn: draft.waitingOn,
  };
}

/**
 * The payload a click may write, or a throw with the reason it may not: every
 * item that will be created is checked exactly the way a drafted board item is,
 * against the board as the click finds it. A skipped item is not checked — its
 * text may say anything, since none of it is written.
 *
 * What comes back carries the board's own spelling of the account and the track,
 * which is also the parent's: a note filed under an engagement takes that
 * engagement's account and track, the same way `add:`'s draft does.
 */
export function validatePayload(payload: NoteItemsPayload, ctx: AddContext, today: string): NoteItemsPayload {
  const creating = itemsToCreate(payload);
  if (creating.length === 0) return payload;
  // The card's numbers, not the array's: an item that is 4th on the card is a 4
  // to ZY, whatever the skipped ones before it did to an index.
  const drafts: AddDraft[] = [];
  for (const { index, item } of creating) {
    const n = index + 1;
    const title = oneLine(item.title);
    if (title === "") throw new Error(`item ${n} needs a title`);
    if (title.length > TITLE_MAX) throw new Error(`item ${n}: the title must be ${TITLE_MAX} characters or fewer`);
    // validateDraft names the field and nothing else: with six items on one card,
    // the refusal needs the number in front of it or ZY cannot find the item.
    try {
      drafts.push(validateDraft(replyOf(draftOf(item, payload)), ctx, today));
    } catch (err) {
      throw new Error(`item ${n}: ${errMessage(err)}`);
    }
  }
  return { ...payload, account: drafts[0].account, track: drafts[0].track };
}

// ---- The card ---------------------------------------------------------------

/** A title or an owner as the card can safely repeat it. */
function mrkdwn(value: string): string {
  // `&`, `<` and `>` are the three Slack reads as markup; `*`, `_` and `~` are left
  // alone, because Slack has no escape for them and an invisible fix would be worse
  // than a stray pair of asterisks in a title.
  return escapeData(oneLine(value));
}

/** A created issue as the card links it: the repo's name and the number, read off the URL. */
function issueLabel(issue: { number: number; url: string }): string {
  const at = issue.url.lastIndexOf("/issues/");
  const name = at === -1 ? "" : issue.url.slice(0, at).split("/").at(-1) ?? "";
  return `<${issue.url}|${name === "" ? "" : `${name}#`}${issue.number}>`;
}

/** One item's progress, or none: a skipped item has no entry at all. */
type Entry = NoteItemsProgress["items"][number];

/** The entry of every item Create writes, by the item's place in the payload. */
function entriesOf(payload: NoteItemsPayload, progress: NoteItemsProgress | null): Map<number, Entry> {
  const entries = new Map<number, Entry>();
  if (progress === null) return entries;
  itemsToCreate(payload).forEach((one, k) => {
    const entry = progress.items[k];
    if (entry !== undefined) entries.set(one.index, entry);
  });
  return entries;
}

/**
 * True when the item is on the board and has nothing left to write: its board
 * item, and then whatever comes after it in its own flow, which is a link when it
 * hangs under an engagement and its fields when it stands alone. The batch's own
 * Apply and the card read this one predicate, so a card never claims an item is
 * on the board that a click would still write.
 */
export function finished(entry: Entry | undefined, parentRef: string | null): boolean {
  if (entry === undefined || entry.itemId === undefined) return false;
  return parentRef === null ? entry.fields !== undefined : entry.linked !== undefined;
}

/** An item a click has written anything for: an entry nothing has touched says nothing was tried. */
function begun(entry: Entry | undefined): boolean {
  if (entry === undefined) return false;
  return (
    entry.error !== null ||
    entry.issue !== undefined ||
    entry.issuePending !== undefined ||
    entry.itemId !== undefined ||
    entry.fields !== undefined ||
    entry.linked !== undefined
  );
}

/** What the progress adds up to: how many of the written items are done, and whether a click began. */
interface Counts {
  toCreate: number;
  created: number;
  unfinished: number;
  started: boolean;
}

function countOf(payload: NoteItemsPayload, entries: Map<number, Entry>): Counts {
  const toCreate = itemsToCreate(payload);
  const created = toCreate.filter((one) => finished(entries.get(one.index), payload.parentRef)).length;
  return {
    toCreate: toCreate.length,
    created,
    unfinished: toCreate.length - created,
    started: toCreate.some((one) => begun(entries.get(one.index))),
  };
}

/** Why a skipped item is not created, in the words the card uses. */
function skipReason(item: NoteItem): string {
  if (item.flag !== null && item.flag.kind === "already-there") return `${item.flag.ref} is already on the board`;
  return "you left it out";
}

/** One item as the card lists it: what has become of it, or what Create would write. */
function itemLine(n: number, item: NoteItem, entry: Entry | undefined, parentRef: string | null): string {
  const title = mrkdwn(item.title);
  if (entry !== undefined && finished(entry, parentRef) && entry.issue !== undefined) return `✅ ${issueLabel(entry.issue)}`;
  if (entry !== undefined && entry.error !== null) {
    // An issue that exists is a partial write the retry continues from; one that
    // does not is the whole item still to be made.
    const what =
      entry.issue === undefined
        ? `not created: ${reasonOf(entry.error)}`
        : `exists, but ${FAILED_STEP[unfinishedStep(entry)]} failed`;
    return `⚠ ${n}. ${title} · ${what}`;
  }
  if (item.as === "skip") return `${n}. ~${title}~ · not created: ${skipReason(item)}`;
  // An item a run stopped in the middle of: it must not look as if nothing happened,
  // and it must not claim a step that did not run. The step it lacks is the one the
  // retry starts from, said the way a failure of that step is said.
  if (entry !== undefined && entry.issue !== undefined && entry.error === null) {
    const where = unfinishedStep(entry);
    return where === "board"
      ? `⚠ ${n}. ${title} · ${issueLabel(entry.issue)} exists, but it is not on the board yet`
      : `⚠ ${n}. ${title} · ${issueLabel(entry.issue)} is on the board, but ${FAILED_STEP[where]} did not finish`;
  }
  const whose = item.as === "waiting" ? `Waiting on ${mrkdwn(item.owner)}` : "Next";
  const when = item.due === null ? "" : ` · ${item.as === "waiting" ? "touch" : "target"} ${fmtDate(item.due)}`;
  return `${n}. *${title}* · ${whose}${when}`;
}

/** Where the proposal stands, in the head: the count is the note's actions, not the card's lines. */
function stateOf(state: NoteItemsState, counts: Counts): string {
  if (state.status === "applying") return "creating…";
  if (state.status === "done") return `created ${counts.created} item${counts.created === 1 ? "" : "s"}`;
  if (state.status === "cancelled") return "cancelled";
  return counts.started ? `${counts.created} of ${counts.toCreate} created` : "nothing created yet";
}

/** What a click can still change is worth warning about; a card that is over is not. */
function cautionsOf(payload: NoteItemsPayload, ctx: AddContext | null): string[] {
  const notes: string[] = [];
  const parent = ctx === null ? null : chooseParent(ctx, payload.account);
  if (payload.account === null && payload.parentRef === null) {
    // Two different notes, two different things to say: a folder somewhere else
    // names no customer at all, and an Accounts/ name the board does not offer is
    // a customer the board has no option for.
    notes.push(
      noteAccount(payload.note.folder) === null
        ? "⚠ A note outside Accounts/ names no account: these are standalone items."
        : "⚠ The note's account is not an Account option on the board: these are standalone items.",
    );
  } else if (payload.candidates === 0 && payload.parentRef === null) {
    notes.push("⚠ No open engagement for this account: these are standalone items.");
  }
  // Several matched and the card took the first. An edit that picks another one
  // is ZY's own choice, so the card no longer claims that it picked.
  if (payload.candidates > 1 && parent !== null && parent.ref !== null && parent.ref === payload.parentRef) {
    notes.push(`⚠ ${payload.candidates} open engagements for this account: picked the most recent.`);
  }
  const past = payload.items.filter((item) => item.as !== "skip" && item.flag !== null && item.flag.kind === "past-due").length;
  if (past === 1) notes.push("⚠ 1 due date was in the past: dropped, it is not written.");
  if (past > 1) notes.push(`⚠ ${past} due dates were in the past: dropped, they are not written.`);
  if (payload.more === 1) notes.push("⚠ 1 more action did not fit this card; use `add:` for it.");
  if (payload.more > 1) notes.push(`⚠ ${payload.more} more actions did not fit this card; use \`add:\` for them.`);
  return notes;
}

/** Where the proposal stands, and what the next click would do. */
function outcomeOf(state: NoteItemsState, payload: NoteItemsPayload, counts: Counts): string {
  const under = payload.parentRef;
  const issues = counts.toCreate === 1 ? "1 issue" : `${counts.toCreate} issues`;
  const them = counts.toCreate === 1 ? "it" : "them";
  const error = state.error === null ? null : reasonOf(state.error);

  if (state.status === "applying") return "→ creating…";

  if (state.status === "done") {
    const items = counts.created === 1 ? "1 item" : `${counts.created} items`;
    return under === null ? `→ created ${items}: on the board.` : `→ created ${items}: on the board, under ${under}.`;
  }

  if (state.status === "cancelled") {
    if (counts.created === 0) return "→ cancelled, nothing was written.";
    return `→ stopped: ${counts.created} of ${counts.toCreate} created; nothing more will be written.`;
  }

  // drafting and open: the card is still the offer, or a run that stopped.
  if (error !== null && !counts.started) return `→ failed: ${error}. Nothing was written.`;
  if (counts.started) {
    const rest = `${counts.unfinished} item${counts.unfinished === 1 ? " is" : "s are"} unfinished.`;
    const retry = "Retry continues from there and creates no second issue.";
    return error === null ? `→ ${rest} ${retry}` : `→ failed: ${error}. ${rest} ${retry}`;
  }
  if (counts.toCreate === 0) return "Nothing to create: every action is on the board already, or left out.";
  const then =
    under === null ? `puts ${them} on the board as standalone items` : `puts ${them} on the board and links ${them} under ${under}`;
  return `Create opens ${issues} in \`${state.repo}\`, ${then}. Nothing is written until then.`;
}

/** What the buttons are: a card that has begun a run retries it, a card that is over has none. */
function buttonsOf(state: NoteItemsState, counts: Counts): ProposalButton[] {
  if (state.status !== "open") return [];
  if (counts.started) return ["retry", "cancel"];
  return counts.toCreate === 0 ? ["edit", "cancel"] : ["create", "edit", "cancel"];
}

/** A card whose payload or context the store could not read: nothing to list, nothing to write. */
const UNREADABLE = "⚠ this card's items could not be read; start over with a new note:";

/** A card whose progress the store could not read: what it has created is unknown. */
const UNREADABLE_PROGRESS = "⚠ what this card has already created could not be read: nothing more will be written.";

/**
 * Where a card stands when nothing of it can be read: its status is all it can
 * honestly say, and an unreadable progress must not be drawn as a batch that
 * created nothing.
 */
function unreadableStateOf(state: NoteItemsState): string {
  if (state.status === "applying") return "creating…";
  if (state.status === "done") return "created";
  if (state.status === "cancelled") return "cancelled";
  return state.progressUnreadable === true ? "unknown" : "nothing created yet";
}

export function noteItemsCard(state: NoteItemsState): Card {
  const payload = state.context === null ? null : state.payload;
  if (payload === null || state.progressUnreadable === true) {
    return {
      head: `${HEAD} · ${unreadableStateOf(state)}`,
      lines: [],
      context: payload === null ? UNREADABLE : UNREADABLE_PROGRESS,
      // Nothing readable means nothing to create and nothing to edit: Cancel is
      // the only way out of a card like that, so the other two are not offered.
      buttons: state.status === "open" ? ["cancel"] : [],
    };
  }
  const entries = entriesOf(payload, state.progress);
  const counts = countOf(payload, entries);
  const total = payload.items.length + payload.more;
  const context =
    state.status === "open" || state.status === "drafting"
      ? [...cautionsOf(payload, state.context), outcomeOf(state, payload, counts)].join(" ")
      : outcomeOf(state, payload, counts);
  return {
    head: `${HEAD} · ${total} action${total === 1 ? "" : "s"} · ${stateOf(state, counts)}`,
    lines: payload.items.map((item, index) => itemLine(index + 1, item, entries.get(index), payload.parentRef)),
    context,
    buttons: buttonsOf(state, counts),
  };
}

// ---- The Edit modal ---------------------------------------------------------

/**
 * The modal of one card: the parent every item hangs under, then the action, the
 * title and the date of each item, in the numbers the card shows them by. A
 * skipped item keeps its inputs, because setting one back to Next is how ZY
 * brings it back.
 */
export function noteItemsEditFields(payload: NoteItemsPayload, ctx: AddContext): EditField[] {
  const engagements = ctx.engagements.map((engagement) => ({
    label: `${engagement.ref} ${oneLine(engagement.title)}`,
    value: engagement.ref,
  }));
  const fields: EditField[] = [selectOf("parent", "Parent for all", engagements, payload.parentRef)];
  payload.items.forEach((item, index) => {
    const n = index + 1;
    fields.push(
      { kind: "select", name: `i${n}.as`, label: `${n}. What to do`, value: item.as, options: AS_OPTIONS },
      { kind: "text", name: `i${n}.title`, label: `${n}. Title`, value: item.title, required: true, maxLength: TITLE_MAX },
      { kind: "date", name: `i${n}.date`, label: `${n}. Date`, value: item.due },
    );
  });
  return fields;
}

/** One subscribed `as` value, or a throw: the modal offers exactly three. */
function asOfEdit(value: string | null, n: number): ItemAs {
  const found = asOfValue(value);
  if (found === null) throw new Error(`item ${n} must be one of next, waiting or skip`);
  return found;
}

/**
 * The payload an edit submitted: the parent and each item's action, title and
 * date from the modal, everything else as it was.
 *
 * A date typed by hand is never dropped the way the note's own past date is: an
 * edit is a request, so a date before today is refused by validatePayload in
 * validateDraft's own words — `targetDate must be <today> or later` for an item
 * that would be Next, `nextTouch must be <today> or later` for one that Waits.
 */
export function payloadFromEdit(
  payload: NoteItemsPayload,
  values: Record<string, string | null>,
  ctx: AddContext,
  today: string,
): NoteItemsPayload {
  const items = payload.items.map((item, index) => {
    const n = index + 1;
    const as = asOfEdit(edited(values, `i${n}.as`, item.as), n);
    const title = oneLine(edited(values, `i${n}.title`, item.title) ?? "");
    const due = edited(values, `i${n}.date`, item.due);
    // A revived item keeps the reason it was skipped only while the reason stands:
    // once its own words no longer name a board item, there is nothing to say.
    // A date the edit left alone keeps its own caution too: changing a title is no
    // statement about a due date the note already had.
    const late = due === item.due && item.flag !== null && item.flag.kind === "past-due";
    const flag = as === "skip" ? item.flag : alreadyThere(title, ctx) ?? (late ? item.flag : null);
    return { ...item, as, title, due, flag };
  });
  return validatePayload({ ...payload, parentRef: edited(values, "parent", payload.parentRef), items }, ctx, today);
}

// ---- The stored JSON --------------------------------------------------------

/** A stored flag, shape only: a kind this version does not know is no flag. */
function readFlag(value: unknown): NoteFlag | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return undefined;
  if (value.kind === "past-due") return { kind: "past-due" };
  if (value.kind === "already-there" && typeof value.ref === "string") return { kind: "already-there", ref: value.ref };
  return undefined;
}

/** A stored item, shape only: what a card reads, never what a date or an option means today. */
function readItem(value: unknown): NoteItem | null {
  if (!isRecord(value)) return null;
  const { title, owner, line } = value;
  if (typeof title !== "string" || typeof owner !== "string" || typeof line !== "string") return null;
  const as = asOfValue(value.as);
  if (as === null) return null;
  const due = stored(value.due);
  const flag = readFlag(value.flag);
  if (due === undefined || flag === undefined) return null;
  return { title, owner, as, due, line, flag };
}

/** A stored count: a payload from another version that never carried one has nothing to count. */
function storedCount(value: unknown): number | undefined {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The payload a card was drawn from, or null. Shape only: a card drawn yesterday
 * still renders today, so nothing here asks whether its dates are still ahead or
 * its engagement is still on the board — the click does, in validatePayload.
 */
export function readNoteItemsPayload(json: string | null): NoteItemsPayload | null {
  const value = parse(json);
  if (!isRecord(value) || value.v !== 1) return null;
  const note = value.note;
  if (!isRecord(note) || typeof note.date !== "string" || typeof note.url !== "string") return null;
  const folder = stored(note.folder);
  const account = stored(value.account);
  const track = stored(value.track);
  const parentRef = stored(value.parentRef);
  const candidates = storedCount(value.candidates);
  const more = storedCount(value.more);
  if (folder === undefined || account === undefined || track === undefined || parentRef === undefined) return null;
  if (candidates === undefined || more === undefined) return null;
  if (!Array.isArray(value.items)) return null;
  const items: NoteItem[] = [];
  for (const raw of value.items) {
    const item = readItem(raw);
    if (item === null) return null;
    items.push(item);
  }
  return { v: 1, note: { date: note.date, url: note.url, folder }, account, track, parentRef, candidates, items, more };
}

/** The board facts a card was drawn from: the same context `add:` reads, so the same reader. */
export function readNoteItemsContext(json: string | null): AddContext | null {
  return readContext(json);
}

/**
 * How far Create got, or null. A progress that cannot be read is not an empty
 * one: an empty one says nothing was written, and the next Create would make a
 * second issue for every item. Only a row whose progress was never saved reads
 * as nothing written.
 */
export function readNoteItemsProgress(json: string | null): NoteItemsProgress | null {
  if (json === null) return { items: [] };
  const value = parse(json);
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  const items: NoteItemsProgress["items"] = [];
  for (const raw of value.items) {
    // One item's four steps are add:'s, read the way add: reads them: an issue
    // that cannot be named cannot be adopted, so it is unreadable, not absent.
    if (!isRecord(raw)) return null;
    const progress = readProgressValue(raw);
    if (progress === null) return null;
    const error = raw.error === null || raw.error === undefined ? null : typeof raw.error === "string" ? raw.error : undefined;
    if (error === undefined) return null;
    items.push({ ...progress, error });
  }
  return { items };
}
