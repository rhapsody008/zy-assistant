// Deterministic reminder rules (zy-ops#7, MVP subset). Pure: no I/O, no clock.
//
// Slots: M = morning briefing, E = end-of-day sweep (weekdays only; the scheduler decides).
// M: one briefing message, plus a direct ping for every In-progress item that needs action:
//    - Target date today, or 1..pingDays days away (deadline ladder; always fires in T-3..T-1)
//    - Target date passed by 1..staleDays days (overdue, daily)
//    - Next touch today or passed (daily until the date moves or the item is Done)
//    Items that are not In progress and match go into the briefing's "Today" list instead.
//    Target soonDays (4..7) away -> "Coming up" briefing line. Overdue > staleDays -> one "Stale dates" line.
//    An E re-ping from the previous workday that is still unacked -> ⚠ line at the top.
// E: a ping for each open item whose Target date is today ("close it or move the date"),
//    and one re-ping for each M ping from today that has no ack.
// Ack = a button press, a thread reply, or the item updated (board or issue) after the ping.
// One message per item per slot; reasons are merged.
//
// Shape: every rule is a pure function (item, env) => Finding[]. Each item goes
// through the rules of its slot in board order, then one merge step turns an
// item's findings into at most one Ping, then one render step turns the morning
// findings into the briefing text. Policy is data: the defaults are the rules
// above, and a caller may override any of them.

import { STATUS } from "./schema.ts";
import { dayDiff, fmtDate, prevWorkday } from "./time.ts";

export type Slot = "M" | "E";

export interface Item {
  id: string; // project item node id
  ref: string; // "demo#52"
  title: string;
  url: string;
  status: string | null;
  target: string | null; // Target date
  nextTouch: string | null;
  nextAction: string | null;
  waitingOn: string | null;
  // Optional board fields (src/schema.ts): all null when the board has none.
  type: string | null; // Type
  stage: string | null; // Stage
  track: string | null; // Track
  account: string | null; // Account
  cadence: string | null; // Cadence
  parentUrl: string | null; // the parent issue of an Issue, for the next step
  updatedAt: string; // ISO, max of item and issue updatedAt
}

export interface SentPing {
  key: string;
  itemId: string;
  date: string;
  slot: Slot;
  kind: "ping" | "reping";
  sentAt: string; // ISO
  ackedAt: string | null;
}

export type ActionId = "ack" | "done" | "touch1" | "touch7";

export interface Ping {
  key: string;
  itemId: string;
  kind: "ping" | "reping";
  text: string;
  actions: ActionId[];
}

export interface Plan {
  briefing: string | null;
  pings: Ping[];
}

export interface Policy {
  /** A Target date 1..pingDays days away is pinged. */
  pingDays: number;
  /** A Target date this many days away (low..high) is a "Coming up" line. */
  soonDays: [number, number];
  /** Overdue by more than this: no daily ping, one "Stale dates" line instead. */
  staleDays: number;
  /** More In-progress items than this is called out in the briefing. */
  wipLimit: number;
  /** The Status option that means "being worked on". */
  inProgress: string;
  /** The Status option that means "closed, say nothing". */
  done: string;
  /**
   * Per item Type, replaces pingDays for that item. Empty: pingDays for all.
   * An item whose type is not in here keeps pingDays.
   */
  leadDaysByType: Record<string, number>;
}

/** Today's behaviour, as data. */
export const DEFAULT_POLICY: Policy = {
  pingDays: 3,
  soonDays: [4, 7],
  staleDays: 14,
  wipLimit: 3,
  inProgress: STATUS.inProgress,
  done: STATUS.done,
  leadDaysByType: {},
};

export type Section = "today" | "soon" | "stale" | "warn";

export interface Env {
  today: string;
  slot: Slot;
  history: SentPing[];
  byId: Map<string, Item>;
  policy: Policy;
}

export interface Finding {
  itemId: string;
  /** The human text. "today"/"soon"/"stale" findings are listed behind the item's link. */
  reason: string;
  section: Section;
  /** True: this finding becomes part of the item's ping ("today" only). */
  ping: boolean;
  actions: ActionId[];
}

export type Rule = (item: Item, env: Env) => Finding[];

export function pingKey(date: string, slot: Slot, itemId: string): string {
  return `${date}:${slot}:${itemId}`;
}

export function isAcked(p: SentPing, item: Item | undefined): boolean {
  if (p.ackedAt) return true;
  return item !== undefined && Date.parse(item.updatedAt) > Date.parse(p.sentAt);
}

const link = (i: Item) => `<${i.url}|${i.ref}> ${i.title}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function contextLines(i: Item): string[] {
  const out: string[] = [];
  if (i.nextAction) out.push(`Next: ${i.nextAction}`);
  if (i.waitingOn) out.push(`Waiting on: ${i.waitingOn}`);
  return out;
}

/** A Next touch that is due or gone already: the ping offers to move it. */
const actionsFor = (item: Item, env: Env): ActionId[] =>
  item.nextTouch !== null && dayDiff(item.nextTouch, env.today) <= 0
    ? ["ack", "touch1", "touch7", "done"]
    : ["ack", "done"];

/** A Target date this many days ahead is still "due in": the item's Type may shorten or stretch it. */
function leadDays(item: Item, policy: Policy): number {
  const byType = item.type === null ? undefined : policy.leadDaysByType[item.type];
  return byType ?? policy.pingDays;
}

// ---- M: the rules that produce a "Today" line, and maybe a ping -------------

const targetDue: Rule = (item, env) => {
  const target = item.target;
  if (!target) return [];
  const d = dayDiff(target, env.today);
  if (d === 0) return [todayFinding(item, env, "*due today*")];
  if (d >= 1 && d <= leadDays(item, env.policy)) return [todayFinding(item, env, `due in ${plural(d, "day")} (${fmtDate(target)})`)];
  if (d < 0 && d >= -env.policy.staleDays) return [todayFinding(item, env, `*overdue* by ${plural(-d, "day")} (target ${fmtDate(target)})`)];
  return [];
};

const nextTouchDue: Rule = (item, env) => {
  const nextTouch = item.nextTouch;
  if (!nextTouch) return [];
  const d = dayDiff(nextTouch, env.today);
  if (d > 0) return [];
  return [todayFinding(item, env, d === 0 ? "touch today" : `touch was ${fmtDate(nextTouch)}`)];
};

/** In progress: a ping. Anything else: only the briefing line. */
function todayFinding(item: Item, env: Env, reason: string): Finding {
  const ping = item.status === env.policy.inProgress;
  return { itemId: item.id, reason, section: "today", ping, actions: ping ? actionsFor(item, env) : [] };
}

/** An item has a "Today" line when one of these two fires. */
const todayReasons = (item: Item, env: Env): string[] => [...targetDue(item, env), ...nextTouchDue(item, env)].map((f) => f.reason);

// ---- M: the briefing-only lines ---------------------------------------------

const targetSoon: Rule = (item, env) => {
  const target = item.target;
  if (!target) return [];
  const d = dayDiff(target, env.today);
  const [low, high] = env.policy.soonDays;
  if (d < low || d > high) return [];
  return [{ itemId: item.id, reason: `due ${fmtDate(target)}`, section: "soon", ping: false, actions: [] }];
};

const targetStale: Rule = (item, env) => {
  const target = item.target;
  if (!target) return [];
  if (dayDiff(target, env.today) >= -env.policy.staleDays) return [];
  return [{ itemId: item.id, reason: `${item.ref} (${target})`, section: "stale", ping: false, actions: [] }];
};

const nextTouchTomorrow: Rule = (item, env) => {
  const nextTouch = item.nextTouch;
  if (!nextTouch || dayDiff(nextTouch, env.today) !== 1) return [];
  // This item's own line only, and only when it has nothing to say today: a ref
  // is not unique (drafts all say "draft", and demo#5 is a substring of demo#52).
  if (todayReasons(item, env).length > 0) return [];
  const waiting = item.waitingOn ? ` (waiting on ${item.waitingOn})` : "";
  return [{ itemId: item.id, reason: `touch tomorrow${waiting}`, section: "soon", ping: false, actions: [] }];
};

/** Yesterday's evening re-ping, still unacked: a warning at the top of the briefing. */
const unackedReping: Rule = (item, env) => {
  if (!unackedRepingFrom(item, env, prevWorkday(env.today))) return [];
  return [
    { itemId: item.id, reason: `⚠ *No update* on ${link(item)} since yesterday's pings`, section: "warn", ping: false, actions: [] },
  ];
};

function unackedRepingFrom(item: Item, env: Env, date: string): SentPing | null {
  const reping = env.history.find((h) => h.itemId === item.id && h.kind === "reping" && h.date === date);
  return reping && !isAcked(reping, env.byId.get(item.id)) ? reping : null;
}

// ---- E: the rules ------------------------------------------------------------

const targetToday: Rule = (item, env) => {
  if (!item.target || item.target !== env.today) return [];
  return [
    {
      itemId: item.id,
      reason: "*due today*: close it, or move the date with a reason",
      section: "today",
      ping: true, // every open item, whatever its status
      actions: actionsFor(item, env),
    },
  ];
};

const morningUnacked: Rule = (item, env) => {
  if (!unackedMorningPing(item, env)) return [];
  return [
    { itemId: item.id, reason: "no update since this morning's ping", section: "today", ping: true, actions: actionsFor(item, env) },
  ];
};

/** This morning's ping of the item, if it got none. */
function unackedMorningPing(item: Item, env: Env): SentPing | null {
  const morning = env.history.find((h) => h.itemId === item.id && h.date === env.today && h.slot === "M");
  return morning && !isAcked(morning, env.byId.get(item.id)) ? morning : null;
}

const MORNING_RULES: Rule[] = [targetDue, nextTouchDue, targetSoon, targetStale, nextTouchTomorrow, unackedReping];
const EVENING_RULES: Rule[] = [targetToday, morningUnacked];

// ---- Plan: rules, then one merge, then one render ---------------------------

interface ItemFindings {
  item: Item;
  findings: Finding[];
}

export function plan(items: Item[], today: string, slot: Slot, history: SentPing[], ctx?: { policy?: Partial<Policy> }): Plan {
  const policy: Policy = { ...DEFAULT_POLICY, ...ctx?.policy };
  const env: Env = {
    today,
    slot,
    history,
    byId: new Map(items.map((i) => [i.id, i])),
    policy,
  };
  const open = items.filter((i) => i.status !== policy.done);
  const rules = slot === "M" ? MORNING_RULES : EVENING_RULES;
  const view = open.map((item) => ({ item, findings: rules.flatMap((rule) => rule(item, env)) }));
  return {
    briefing: slot === "M" ? renderBriefing(view, env) : null,
    pings: mergePings(view, env),
  };
}

/** One ping per item per slot, however many reasons fired; they are merged. */
function mergePings(view: ItemFindings[], env: Env): Ping[] {
  const joiner = env.slot === "M" ? ", " : "; ";
  const pings: Ping[] = [];
  for (const { item, findings } of view) {
    const pinged = findings.filter((f) => f.ping);
    if (pinged.length === 0) continue;
    pings.push({
      key: pingKey(env.today, env.slot, item.id),
      itemId: item.id,
      // An evening ping that answers an unanswered morning ping is a re-ping.
      kind: env.slot === "E" && unackedMorningPing(item, env) ? "reping" : "ping",
      text: [`${link(item)}: ${pinged.map((f) => f.reason).join(joiner)}`, ...contextLines(item)].join("\n"),
      // Every rule returns the same action set for one item in one slot.
      actions: pinged[0].actions,
    });
  }
  return pings;
}

function renderBriefing(view: ItemFindings[], env: Env): string {
  const policy = env.policy;
  const inSection = (name: Section): Finding[] => view.flatMap((v) => v.findings.filter((f) => f.section === name));

  const parts: string[] = [`*Morning briefing, ${fmtDate(env.today)}*`];

  // Warnings keep the history's order, not the board's.
  const warn = inSection("warn").sort((a, b) => warnOrder(env, a) - warnOrder(env, b));
  if (warn.length > 0) parts.push(warn.map((f) => f.reason).join("\n"));

  const today = view
    .map((v) => ({ item: v.item, reasons: v.findings.filter((f) => f.section === "today").map((f) => f.reason) }))
    .filter((line) => line.reasons.length > 0)
    .map((line) => `• ${link(line.item)}: ${line.reasons.join(", ")}`);
  parts.push(today.length > 0 ? `*Today*\n${today.join("\n")}` : "*Today*\nNothing due. 🎉");

  const soon = view
    .flatMap((v) => v.findings.filter((f) => f.section === "soon").map((f) => `• ${link(v.item)}: ${f.reason}`));
  if (soon.length > 0) parts.push(`*Coming up*\n${soon.join("\n")}`);

  const stale = inSection("stale").map((f) => f.reason);
  if (stale.length > 0) parts.push(`*Stale dates* (more than ${policy.staleDays} days overdue, fix or close): ${stale.join(", ")}`);

  const wip = view.filter((v) => v.item.status === policy.inProgress).length;
  parts.push(`In progress: ${wip}${wip > policy.wipLimit ? ` (over the limit of ${policy.wipLimit}: what are you dropping?)` : ""}`);

  return parts.join("\n\n");
}

function warnOrder(env: Env, finding: Finding): number {
  return env.history.findIndex((h) => h.itemId === finding.itemId && h.kind === "reping" && h.date === prevWorkday(env.today));
}
