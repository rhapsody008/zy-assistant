// State: one SQLite file. What was pinged (and whether it was acked), which
// briefings went out, which slots already ran, how often a failing slot has been
// retried, every dictation the scribe has not finished with yet, the questions
// the DM has taken and answered (the claims that dedupe a redelivery, and the
// answers a follow-up in their thread quotes), and the proposals the DM has
// drafted and is waiting on a click for. `:memory:` is accepted so tests never
// touch the disk.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pingKey, type SentPing, type Slot } from "./rules.ts";

export interface NewPing {
  key: string;
  itemId: string;
  date: string;
  slot: Slot;
  kind: "ping" | "reping";
  sentAt: string; // ISO
  channel: string;
  ts: string; // Slack message ts, the thread parent a reply can point at
}

export interface PingRecord extends SentPing {
  channel: string;
  ts: string;
}

export type DictationStatus = "stored" | "asked" | "writing" | "done" | "failed" | "cancelled";

/** One `note: ...` DM: the raw text first, then whatever the model made of it. */
export interface Dictation {
  ts: string; // the Slack message ts: the dedupe key
  text: string; // the dictation, verbatim
  status: DictationStatus;
  folder: string | null; // where the note went, or will go
  noteJson: string | null; // the extracted note, so a folder choice never calls the model again
  commitUrl: string | null;
  createdAt: string; // ISO
  error: string | null;
}

/** Only the fields being changed: a status stays until something sets it. */
export interface DictationPatch {
  status?: DictationStatus;
  folder?: string | null;
  noteJson?: string | null;
  commitUrl?: string | null;
  error?: string | null;
}

export interface DictationStore {
  /** Stores the raw text before anything else; false when that ts was stored already. */
  recordDictation(dictation: { ts: string; text: string; createdAt: string }): boolean;
  /**
   * Takes the dictation for writing: true only for the call that moved it out of
   * one of `from`. A second click, or a second delivery, gets false.
   */
  claimDictation(ts: string, from: DictationStatus[]): boolean;
  findDictation(ts: string): Dictation | null;
  updateDictation(ts: string, patch: DictationPatch): void;
}

/** One answered question: the answer message, and the thread it belongs to. */
export interface AskRecord {
  ts: string; // the answer message's ts, the key: what a follow-up in the thread looks up
  threadTs: string; // the thread the question was asked in and answered in
  question: string;
  answer: string;
  createdAt: string; // ISO
}

/** Where a proposal is in its life: drafted, waiting for a click, being applied, or over. */
export type ProposalStatus = "drafting" | "open" | "applying" | "done" | "cancelled";

/** One proposal: what the bot put on a card, and what has been written for it so far. */
export interface Proposal {
  id: string; // "<kind>:<source key>", e.g. "add:<slack message ts>": the redelivery dedupe
  kind: string;
  status: ProposalStatus;
  source: string; // the words the proposal came from, verbatim
  payload: string | null; // JSON: what the card shows, and what Apply writes
  context: string | null; // JSON: the board facts it was drafted against, for the card and the Edit modal
  progress: string | null; // JSON: the writes already done, so a retry never writes twice
  rev: number; // +1 per edit: a click on a card that has moved on is refused
  channel: string | null; // where the card is, for a redraw after a restart or a modal
  messageTs: string | null;
  createdAt: string; // ISO
  error: string | null;
}

/** Only the fields being changed: a status stays until something sets it. */
export interface ProposalPatch {
  status?: ProposalStatus;
  payload?: string | null;
  context?: string | null;
  progress?: string | null;
  channel?: string | null;
  messageTs?: string | null;
  error?: string | null;
}

export interface ProposalStore {
  /** Stores the proposal before anything else; false when that id was stored already (a redelivery). */
  recordProposal(proposal: { id: string; kind: string; source: string; createdAt: string }): boolean;
  findProposal(id: string): Proposal | null;
  /**
   * Takes the proposal: true only for the call that moved it out of one of `from`.
   * A second click, a second delivery, or a cancel racing a Create gets false.
   */
  claimProposal(id: string, from: ProposalStatus[], to: ProposalStatus): boolean;
  updateProposal(id: string, patch: ProposalPatch): void;
  /** An edit of an open proposal at that revision: false when it moved on (stale rev, applied, cancelled). */
  editProposal(id: string, rev: number, payload: string): boolean;
  /**
   * The rows this store's constructor reset, once and in that order: the applies
   * it reopened, then the drafts it cancelled. Their cards are still on screen
   * with their buttons on them, so the process that comes up redraws them.
   */
  interrupted(): Proposal[];
}

export interface AskStore {
  /**
   * Takes the question's own message ts: true for the first delivery and false
   * for any after it, so a redelivered Slack event is answered once. The claim is
   * kept whether the answer succeeds or not.
   */
  claimAsk(ts: string, at: string): boolean;
  recordAsk(ask: AskRecord): void;
  /** The last `limit` answers in one thread, oldest first: the talk before a follow-up. */
  asksInThread(threadTs: string, limit: number): AskRecord[];
  /** Drops what is older than `before` (ISO): the answers, and the claims with them. */
  pruneAsks(before: string): number;
}

/** How long an answered question stays, for the follow-up in its thread. */
export const ASK_RETENTION_DAYS = 30;

/** The instant before which answers and claims are pruned, `at` minus the retention. */
export function askCutoff(at: Date): string {
  return new Date(at.getTime() - ASK_RETENTION_DAYS * 86_400_000).toISOString();
}

export interface PingStore {
  recordPing(ping: NewPing): void;
  historySince(date: string): SentPing[];
  markAcked(key: string, at: string): void;
  findByKey(key: string): PingRecord | null;
  findByMessage(channel: string, ts: string): PingRecord | null;
  slotRan(date: string, slot: Slot): boolean;
  markSlotRan(date: string, slot: Slot, at: string): void;
  /** The briefing of a slot is sent once, however many retries the slot needs. */
  briefingSent(date: string, slot: Slot): boolean;
  recordBriefing(date: string, slot: Slot, at: string): void;
  /** Counts one failed attempt at a slot and returns the total. */
  recordSlotFailure(date: string, slot: Slot, error: string): number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pings (
  key TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  kind TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  acked_at TEXT,
  channel TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pings_message ON pings (channel, ts);
CREATE TABLE IF NOT EXISTS slot_runs (
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  ran_at TEXT NOT NULL,
  PRIMARY KEY (date, slot)
);
-- Separate from pings: a briefing is not a ping and must never reach plan().
CREATE TABLE IF NOT EXISTS briefings (
  key TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  sent_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS slot_failures (
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  last_error TEXT NOT NULL,
  PRIMARY KEY (date, slot)
);
-- Every dictation, from the moment it is stored: the model can be down, GitHub
-- can be down, and the words are not to be lost either way.
CREATE TABLE IF NOT EXISTS dictations (
  ts TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  folder TEXT,
  note_json TEXT,
  commit_url TEXT,
  created_at TEXT NOT NULL,
  error TEXT
);
-- Every proposal, from the moment it is drafted: a card on screen outlives the
-- process that put it there, and a click must never write the same thing twice.
-- The id is the kind plus the key of what it came from, so a redelivered Slack
-- event drafts one card, not two.
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  payload TEXT,
  context TEXT,
  progress TEXT,
  rev INTEGER NOT NULL DEFAULT 0,
  channel TEXT,
  message_ts TEXT,
  created_at TEXT NOT NULL,
  error TEXT
);
-- Every question answered in the DM, so a reply in that thread can carry the
-- conversation it belongs to. Pruned after a month: it is context, not a record.
CREATE TABLE IF NOT EXISTS asks (
  ts TEXT PRIMARY KEY,
  thread_ts TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS asks_thread ON asks (thread_ts, created_at);
-- Every question message taken, written before the model is called: Slack
-- delivers the same event twice sometimes, and one question has one answer.
CREATE TABLE IF NOT EXISTS asks_seen (
  ts TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

const text = (v: unknown): string => (typeof v === "string" ? v : String(v));

function toSentPing(row: Row): SentPing {
  return {
    key: text(row.key),
    itemId: text(row.item_id),
    date: text(row.date),
    slot: row.slot === "E" ? "E" : "M",
    kind: row.kind === "reping" ? "reping" : "ping",
    sentAt: text(row.sent_at),
    ackedAt: row.acked_at === null || row.acked_at === undefined ? null : text(row.acked_at),
  };
}

function toPingRecord(row: Row): PingRecord {
  return { ...toSentPing(row), channel: text(row.channel), ts: text(row.ts) };
}

const nullableText = (v: unknown): string | null => (v === null || v === undefined ? null : text(v));

function toDictation(row: Row): Dictation {
  return {
    ts: text(row.ts),
    text: text(row.text),
    status: text(row.status) as DictationStatus,
    folder: nullableText(row.folder),
    noteJson: nullableText(row.note_json),
    commitUrl: nullableText(row.commit_url),
    createdAt: text(row.created_at),
    error: nullableText(row.error),
  };
}

function toProposal(row: Row): Proposal {
  return {
    id: text(row.id),
    kind: text(row.kind),
    status: text(row.status) as ProposalStatus,
    source: text(row.source),
    payload: nullableText(row.payload),
    context: nullableText(row.context),
    progress: nullableText(row.progress),
    rev: Number(row.rev),
    channel: nullableText(row.channel),
    messageTs: nullableText(row.message_ts),
    createdAt: text(row.created_at),
    error: nullableText(row.error),
  };
}

/** `${date}:${slot}:briefing`, the same shape as a ping key. */
export const briefingKey = (date: string, slot: Slot): string => pingKey(date, slot, "briefing");

function toAsk(row: Row): AskRecord {
  return {
    ts: text(row.ts),
    threadTs: text(row.thread_ts),
    question: text(row.question),
    answer: text(row.answer),
    createdAt: text(row.created_at),
  };
}

export class SqliteStore implements PingStore, DictationStore, AskStore, ProposalStore {
  #db: DatabaseSync;
  #interrupted: string[]; // the ids the constructor reset, read out once

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(SCHEMA);
    // A write the last process never finished: hand it back to the retry button.
    this.#db.exec("UPDATE dictations SET status = 'failed', error = 'interrupted by a restart' WHERE status = 'writing'");
    // An apply the last process never finished: the card is still there, so the
    // next click carries on from the writes it recorded rather than repeating them.
    // The ids are read first: those are the cards the process that starts now has
    // to redraw, and the order is the order they are reset in.
    const applying = this.#idsIn("applying");
    const drafting = this.#idsIn("drafting");
    this.#db.exec("UPDATE proposals SET status = 'open', error = 'interrupted by a restart' WHERE status = 'applying'");
    // A draft the process never finished drawing: its ✍️ ack may well be on
    // screen, and the startup redraw (redrawProposalCard) is what turns that ack
    // into "interrupted", so nothing here waits for a click that never comes.
    this.#db.exec("UPDATE proposals SET status = 'cancelled', error = 'interrupted by a restart' WHERE status = 'drafting'");
    this.#interrupted = [...applying, ...drafting];
  }

  /** The proposals in one status, oldest first: the order a restart brings them back in. */
  #idsIn(status: ProposalStatus): string[] {
    return this.#db
      .prepare("SELECT id FROM proposals WHERE status = ? ORDER BY created_at, id")
      .all(status)
      .map((row) => text(row.id));
  }

  recordPing(p: NewPing): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO pings (key, item_id, date, slot, kind, sent_at, acked_at, channel, ts) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)")
      .run(p.key, p.itemId, p.date, p.slot, p.kind, p.sentAt, p.channel, p.ts);
  }

  historySince(date: string): SentPing[] {
    const rows = this.#db.prepare("SELECT * FROM pings WHERE date >= ? ORDER BY date, slot, sent_at").all(date);
    return rows.map(toSentPing);
  }

  markAcked(key: string, at: string): void {
    this.#db.prepare("UPDATE pings SET acked_at = ? WHERE key = ?").run(at, key);
  }

  findByKey(key: string): PingRecord | null {
    const row = this.#db.prepare("SELECT * FROM pings WHERE key = ?").get(key);
    return row ? toPingRecord(row) : null;
  }

  findByMessage(channel: string, ts: string): PingRecord | null {
    const row = this.#db.prepare("SELECT * FROM pings WHERE channel = ? AND ts = ?").get(channel, ts);
    return row ? toPingRecord(row) : null;
  }

  slotRan(date: string, slot: Slot): boolean {
    return this.#db.prepare("SELECT 1 FROM slot_runs WHERE date = ? AND slot = ?").get(date, slot) !== undefined;
  }

  markSlotRan(date: string, slot: Slot, at: string): void {
    this.#db.prepare("INSERT OR REPLACE INTO slot_runs (date, slot, ran_at) VALUES (?, ?, ?)").run(date, slot, at);
  }

  briefingSent(date: string, slot: Slot): boolean {
    return this.#db.prepare("SELECT 1 FROM briefings WHERE key = ?").get(briefingKey(date, slot)) !== undefined;
  }

  recordBriefing(date: string, slot: Slot, at: string): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO briefings (key, date, slot, sent_at) VALUES (?, ?, ?, ?)")
      .run(briefingKey(date, slot), date, slot, at);
  }

  recordSlotFailure(date: string, slot: Slot, error: string): number {
    this.#db
      .prepare(
        `INSERT INTO slot_failures (date, slot, attempts, last_error) VALUES (?, ?, 1, ?)
         ON CONFLICT(date, slot) DO UPDATE SET attempts = attempts + 1, last_error = excluded.last_error`,
      )
      .run(date, slot, error);
    const row = this.#db.prepare("SELECT attempts FROM slot_failures WHERE date = ? AND slot = ?").get(date, slot);
    return row ? Number(row.attempts) : 1;
  }

  recordDictation(dictation: { ts: string; text: string; createdAt: string }): boolean {
    const result = this.#db
      .prepare("INSERT INTO dictations (ts, text, status, created_at) VALUES (?, ?, 'stored', ?) ON CONFLICT(ts) DO NOTHING")
      .run(dictation.ts, dictation.text, dictation.createdAt);
    return Number(result.changes) > 0;
  }

  findDictation(ts: string): Dictation | null {
    const row = this.#db.prepare("SELECT * FROM dictations WHERE ts = ?").get(ts);
    return row ? toDictation(row) : null;
  }

  claimDictation(ts: string, from: DictationStatus[]): boolean {
    if (from.length === 0) return false;
    // One statement, so two clicks cannot both win: the second sees 'writing'.
    const marks = from.map(() => "?").join(", ");
    const result = this.#db
      .prepare(`UPDATE dictations SET status = 'writing' WHERE ts = ? AND status IN (${marks})`)
      .run(ts, ...from);
    return Number(result.changes) === 1;
  }

  updateDictation(ts: string, patch: DictationPatch): void {
    const columns: string[] = [];
    const values: Array<string | null> = [];
    const set = (column: string, value: string | null | undefined): void => {
      if (value === undefined) return;
      columns.push(`${column} = ?`);
      values.push(value);
    };
    set("status", patch.status);
    set("folder", patch.folder);
    set("note_json", patch.noteJson);
    set("commit_url", patch.commitUrl);
    set("error", patch.error);
    if (columns.length === 0) return;
    this.#db.prepare(`UPDATE dictations SET ${columns.join(", ")} WHERE ts = ?`).run(...values, ts);
  }

  recordProposal(proposal: { id: string; kind: string; source: string; createdAt: string }): boolean {
    const result = this.#db
      .prepare("INSERT INTO proposals (id, kind, status, source, created_at) VALUES (?, ?, 'drafting', ?, ?) ON CONFLICT(id) DO NOTHING")
      .run(proposal.id, proposal.kind, proposal.source, proposal.createdAt);
    return Number(result.changes) > 0;
  }

  findProposal(id: string): Proposal | null {
    const row = this.#db.prepare("SELECT * FROM proposals WHERE id = ?").get(id);
    return row ? toProposal(row) : null;
  }

  claimProposal(id: string, from: ProposalStatus[], to: ProposalStatus): boolean {
    if (from.length === 0) return false;
    // One statement, so a cancel racing a Create cannot both win: the loser sees `to`.
    const marks = from.map(() => "?").join(", ");
    const result = this.#db
      .prepare(`UPDATE proposals SET status = ? WHERE id = ? AND status IN (${marks})`)
      .run(to, id, ...from);
    return Number(result.changes) === 1;
  }

  updateProposal(id: string, patch: ProposalPatch): void {
    const columns: string[] = [];
    const values: Array<string | null> = [];
    const set = (column: string, value: string | null | undefined): void => {
      if (value === undefined) return;
      columns.push(`${column} = ?`);
      values.push(value);
    };
    set("status", patch.status);
    set("payload", patch.payload);
    set("context", patch.context);
    set("progress", patch.progress);
    set("channel", patch.channel);
    set("message_ts", patch.messageTs);
    set("error", patch.error);
    if (columns.length === 0) return;
    this.#db.prepare(`UPDATE proposals SET ${columns.join(", ")} WHERE id = ?`).run(...values, id);
  }

  editProposal(id: string, rev: number, payload: string): boolean {
    // The rev is in the WHERE: the click came from the card as it was drawn then.
    const result = this.#db
      .prepare("UPDATE proposals SET payload = ?, rev = rev + 1 WHERE id = ? AND rev = ? AND status = 'open' AND progress IS NULL")
      .run(payload, id, rev);
    return Number(result.changes) === 1;
  }

  interrupted(): Proposal[] {
    const ids = this.#interrupted;
    this.#interrupted = [];
    // A row something else has taken back in the meantime is not a card to redraw.
    return ids.flatMap((id) => {
      const row = this.findProposal(id);
      return row === null ? [] : [row];
    });
  }

  claimAsk(ts: string, at: string): boolean {
    const result = this.#db.prepare("INSERT OR IGNORE INTO asks_seen (ts, seen_at) VALUES (?, ?)").run(ts, at);
    return Number(result.changes) > 0;
  }

  recordAsk(ask: AskRecord): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO asks (ts, thread_ts, question, answer, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(ask.ts, ask.threadTs, ask.question, ask.answer, ask.createdAt);
  }

  asksInThread(threadTs: string, limit: number): AskRecord[] {
    if (limit < 1) return [];
    // Newest first, then read back to front: the caller wants the talk in order.
    const rows = this.#db
      .prepare("SELECT * FROM asks WHERE thread_ts = ? ORDER BY created_at DESC, ts DESC LIMIT ?")
      .all(threadTs, limit);
    return rows.map(toAsk).reverse();
  }

  pruneAsks(before: string): number {
    const answers = this.#db.prepare("DELETE FROM asks WHERE created_at < ?").run(before);
    // A claim a redelivery could still come for is months old by any measure.
    this.#db.prepare("DELETE FROM asks_seen WHERE seen_at < ?").run(before);
    return Number(answers.changes);
  }

  close(): void {
    this.#db.close();
  }
}

export function openStore(dbPath: string): SqliteStore {
  return new SqliteStore(dbPath);
}
