// Deterministic reminder rules (zy-ops#7). Pure: no I/O, no clock.
//
// Slots: M = morning briefing, E = end-of-day sweep (weekdays only; the scheduler decides).
// M: ONE briefing message. Its "Today" list has one row per item that needs
//    action, whatever the item's status, and each row carries a menu of the
//    actions its findings allow:
//    - Target date today, or 1..pingDays days away (deadline ladder; always fires in T-3..T-1)
//    - Target date passed by 1..staleDays days (overdue, daily)
//    - Next touch today or passed (daily until the date moves or the item is Done)
//    - A Work type with a lead time: exactly on a milestone day (T-heads, T-7 for a
//      Workshop or a POC), whatever the status, so the prep starts two weeks out
//    - Status Waiting, no Next touch at all, no update for waitingChaseDays, and
//      no ping of the item within those same waitingChaseDays
//    The rows are ordered by rowOrder: late, then today, then due soon, then a
//    chase, then a milestone heads-up.
//    Target soonDays (4..7, or up to the Work type's heads) away -> "Coming up" line.
//    Overdue > staleDays -> one "Stale dates" line. An E re-ping from the previous
//    workday that is still unacked -> ⚠ line at the top.
//    Friday only: a "Pipeline" line per open Stage item nobody touched for
//    stageStaleDays, and a "Learning" line per Learn-track item with a cadence.
// E: a ping for each open item whose Target date is today ("close it or move the date"),
//    and one re-ping for each M row from today that has no ack and still has
//    something the sweep can act on: a Target date 0..staleDays days past, or a
//    Next touch due today or past. A due-in-N row, a milestone heads-up and a
//    chase do not re-ping.
// Ack = a menu pick, a button press, a reply in an E ping's thread, the item
// updated (board or issue) after the ping, or a notes-repo commit under the item's
// Account after the ping.
// One row per item per slot; reasons are merged, and so are their actions.
// WIP: an item with sub-issues on the board is a parent, an engagement rather than
// a unit of work, so the In progress count and its list leave it out (workItems).
//
// Shape: every rule is a pure function (item, env) => Finding[]. Each item goes
// through the rules of its slot in board order, then one merge step turns an
// item's findings into at most one Ping, then one render step turns the morning
// findings into the briefing (its text, and the sections and rows Slack posts).
// Policy is data: the defaults are the rules above, and a caller may override any
// of them.

import { PIPELINE_STAGES, STATUS, TRACK } from "./schema.ts";
import { dayDiff, fmtDate, isFriday, latestIso, prevWorkday, weekStart } from "./time.ts";

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
  contentId: string | null; // the Issue node id a comment goes to; null for a draft
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

export type ActionId = "ack" | "done" | "touch1" | "touch7" | "move";

export interface Ping {
  key: string;
  itemId: string;
  kind: "ping" | "reping";
  text: string;
  actions: ActionId[];
}

/**
 * The morning briefing, in the shape Slack posts it: sections above the rows,
 * the rows themselves, and the sections under them. `text` is the same thing
 * rendered flat, for a notification fallback, a dry run and the `today` preview.
 */
export interface Briefing {
  text: string;
  head: string[];
  rows: Ping[];
  tail: string[];
}

export interface Plan {
  /** The briefing, in the morning slot only. */
  briefing: Briefing | null;
  /** The pings of the evening sweep. The morning sends the briefing alone. */
  pings: Ping[];
}

/** When a Work type shows up in the briefing, and the days it is pinged outright. */
export interface LeadTime {
  /** The "Coming up" line starts this many days before the Target date. */
  heads: number;
  /** Days before the Target date on which the item is pinged directly. */
  milestones: number[];
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
  /** The Status option that means "waiting on someone else". */
  waiting: string;
  /** The Status option that means "closed, say nothing". */
  done: string;
  /**
   * Per Work type, when the item starts showing up and when it is pinged.
   * An item whose type is not in here keeps soonDays and gets no milestone ping.
   */
  leadByType: Record<string, LeadTime>;
  /** A Waiting item with no update for more than this many days is chased. */
  waitingChaseDays: number;
  /** An open Stage item with no update for more than this many days is nagged on Friday. */
  stageStaleDays: number;
  /** The Stage options that make an item part of the open pipeline. */
  pipelineStages: readonly string[];
  /** The Track option whose cadence is reported every Friday. */
  learnTrack: string;
}

/** Today's behaviour, as data. */
export const DEFAULT_POLICY: Policy = {
  pingDays: 3,
  soonDays: [4, 7],
  staleDays: 14,
  wipLimit: 3,
  inProgress: STATUS.inProgress,
  waiting: STATUS.waiting,
  done: STATUS.done,
  leadByType: {
    Workshop: { heads: 14, milestones: [14, 7] },
    POC: { heads: 14, milestones: [14, 7] },
  },
  waitingChaseDays: 5,
  stageStaleDays: 21,
  pipelineStages: PIPELINE_STAGES,
  learnTrack: TRACK.learn,
};

export type Section = "today" | "soon" | "stale" | "warn" | "pipeline" | "learning";

export interface Env {
  today: string;
  slot: Slot;
  history: SentPing[];
  byId: Map<string, Item>;
  policy: Policy;
  /** itemId -> ISO of the last notes-repo commit under the item's Account. */
  activity: Map<string, string>;
  /** itemId -> its position on the board, the tiebreak of the briefing's rows. */
  index: Map<string, number>;
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

/**
 * Acked by a button, a reply, or any sign of life after the ping: the item's own
 * updatedAt, or a notes-repo commit under its Account (activity).
 */
export function isAcked(p: SentPing, item: Item | undefined, activity?: Map<string, string>): boolean {
  if (p.ackedAt) return true;
  const since = latestIso(item?.updatedAt, activity?.get(p.itemId));
  return since !== null && Date.parse(since) > Date.parse(p.sentAt);
}

/**
 * The items that are a unit of work. An item another item names as its parent is
 * an engagement ("Acme · POC"), and an engagement in progress is not work in
 * progress: its sub-issues are. The children stay, wherever they are on the board;
 * a parent with no child on the board counts, since nothing says it is one.
 */
export function workItems(items: readonly Item[]): Item[] {
  const parents = new Set(items.flatMap((item) => (item.parentUrl === null ? [] : [item.parentUrl])));
  return items.filter((item) => !parents.has(item.url));
}

/** The calendar date of an ISO timestamp. */
const isoDate = (iso: string): string => iso.slice(0, 10);

const daysSince = (iso: string, today: string): number => dayDiff(today, isoDate(iso));

const link = (i: Item) => `<${i.url}|${i.ref}> ${i.title}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function contextLines(i: Item): string[] {
  const out: string[] = [];
  if (i.nextAction) out.push(`Next: ${i.nextAction}`);
  if (i.waitingOn) out.push(`Waiting on: ${i.waitingOn}`);
  return out;
}

/** A Next touch that is due or gone already. */
const touchDue = (item: Item, env: Env): boolean => item.nextTouch !== null && dayDiff(item.nextTouch, env.today) <= 0;

/**
 * Where an item's row goes: a tier, the date that put it there (ascending), then
 * the board's order. Tier 0 late, 1 today, 2 due soon, 3 a chase, 4 a milestone
 * heads-up. An item with several reasons takes its most urgent one; a chase has
 * no date of its own, so the chases keep board order. A milestone heads-up is
 * the last reason of all: it only decides when nothing else put the row there.
 */
export type RowOrder = [tier: number, date: string, board: number];

export function rowOrder(item: Item, env: Env): RowOrder {
  const board = env.index.get(item.id) ?? 0;
  const dates: Array<[number, string]> = [];
  if (item.target !== null) {
    const d = dayDiff(item.target, env.today);
    // The same bound as targetDue: past staleDays the target is a stale date
    // line, not a late row, and it must not sort the row to the top either.
    const tier = d < 0 ? (d >= -env.policy.staleDays ? 0 : -1) : d === 0 ? 1 : d <= env.policy.pingDays ? 2 : -1;
    if (tier >= 0) dates.push([tier, item.target]);
  }
  if (item.nextTouch !== null) {
    const d = dayDiff(item.nextTouch, env.today);
    if (d < 0) dates.push([0, item.nextTouch]);
    else if (d === 0) dates.push([1, item.nextTouch]);
  }
  if (dates.length === 0) {
    // Nothing is due or touching: a milestone heads-up, or else a chase.
    const milestone = milestoneOf(item, env);
    if (milestone && !chaseDue(item, env)) return [4, milestone.target, board];
    return [3, env.today, board];
  }
  let best = dates[0];
  for (const candidate of dates) {
    if (candidate[0] < best[0] || (candidate[0] === best[0] && candidate[1] < best[1])) best = candidate;
  }
  return [best[0], best[1], board];
}

const compareOrder = (a: RowOrder, b: RowOrder): number =>
  a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || a[2] - b[2];

/** A Target date ping: ack, move the date, and the touch buttons when a touch is due. */
const targetActions = (item: Item, env: Env): ActionId[] =>
  touchDue(item, env) ? ["ack", "move", "touch1", "touch7", "done"] : ["ack", "move", "done"];

/** A ping about a touch or a chase: there is no date line to move. */
const actionsFor = (item: Item, env: Env): ActionId[] =>
  touchDue(item, env) ? ["ack", "touch1", "touch7", "done"] : ["ack", "done"];

/** The Work type's lead time, or null: the item keeps soonDays and has no milestone. */
function leadFor(item: Item, policy: Policy): LeadTime | null {
  return item.type === null ? null : policy.leadByType[item.type] ?? null;
}

/** The Target date's days-left when it lands on a Work-type milestone day, else null. */
function milestoneOf(item: Item, env: Env): { days: number; target: string } | null {
  const target = item.target;
  if (!target) return null;
  const lead = leadFor(item, env.policy);
  const days = dayDiff(target, env.today);
  return lead && lead.milestones.includes(days) ? { days, target } : null;
}

// ---- M: the rules that produce a "Today" line, and maybe a ping -------------

const targetDue: Rule = (item, env) => {
  const target = item.target;
  if (!target) return [];
  const d = dayDiff(target, env.today);
  const actions = targetActions(item, env);
  if (d === 0) return [todayFinding(item, "*due today*", actions)];
  if (d >= 1 && d <= env.policy.pingDays) return [todayFinding(item, `due in ${plural(d, "day")} (${fmtDate(target)})`, actions)];
  if (d < 0 && d >= -env.policy.staleDays) return [todayFinding(item, `*overdue* by ${plural(-d, "day")} (target ${fmtDate(target)})`, actions)];
  return [];
};

const nextTouchDue: Rule = (item, env) => {
  const nextTouch = item.nextTouch;
  if (!nextTouch) return [];
  const d = dayDiff(nextTouch, env.today);
  if (d > 0) return [];
  return [todayFinding(item, d === 0 ? "*touch today*" : `*touch was ${fmtDate(nextTouch)}*`, actionsFor(item, env))];
};

/** T-heads, T-7: the prep for a Workshop or a POC starts before the deadline ladder. */
const milestone: Rule = (item, env) => {
  const due = milestoneOf(item, env);
  if (!due) return [];
  return [
    {
      itemId: item.id,
      reason: `${item.type} in ${plural(due.days, "day")} (${fmtDate(due.target)})`,
      // Whatever the status: two weeks out is when the room gets booked.
      section: "today",
      ping: true,
      actions: ["ack", "move"],
    },
  ];
};

/** Waiting on someone, and nothing has moved: ask them again. */
const waitingChase: Rule = (item, env) => {
  if (!chaseDue(item, env)) return [];
  return [
    {
      itemId: item.id,
      reason: `chase ${item.waitingOn || "them"}?`,
      section: "today",
      ping: true,
      actions: ["ack", "touch1", "touch7", "done"],
    },
  ];
};

/**
 * A Waiting item nobody has moved in waitingChaseDays, that has no Next touch to
 * wait for and no ping of its own within the window. The chase rule and the row
 * order both read it, so the two cannot disagree about what a chase is.
 */
function chaseDue(item: Item, env: Env): boolean {
  if (item.status !== env.policy.waiting) return false;
  // Any Next touch wins: a due one pings on its own, a future one means
  // "leave it until then".
  if (item.nextTouch !== null) return false;
  if (daysSince(item.updatedAt, env.today) <= env.policy.waitingChaseDays) return false;
  // A ping that went out within the window is a chase already made: repeating it
  // every morning until someone answers is noise, not a reminder.
  return !pingedRecently(item, env);
}

/** True when the item was pinged at all within the last waitingChaseDays days. */
function pingedRecently(item: Item, env: Env): boolean {
  return env.history.some((h) => h.itemId === item.id && daysSince(h.sentAt, env.today) <= env.policy.waitingChaseDays);
}

/** A date or a touch is due: a row of the briefing, with its menu, whatever the status. */
function todayFinding(item: Item, reason: string, actions: ActionId[]): Finding {
  return { itemId: item.id, reason, section: "today", ping: true, actions };
}

/** An item has a "Today" line when one of these two fires. */
const todayReasons = (item: Item, env: Env): string[] => [...targetDue(item, env), ...nextTouchDue(item, env)].map((f) => f.reason);

// ---- M: the briefing-only lines ---------------------------------------------

const targetSoon: Rule = (item, env) => {
  const target = item.target;
  if (!target) return [];
  const d = dayDiff(target, env.today);
  const [low, high] = env.policy.soonDays;
  // A Work type with a lead time starts showing up at T-heads instead of T-7.
  const heads = leadFor(item, env.policy)?.heads ?? high;
  if (d < low || d > heads) return [];
  // On a milestone day the item is pinged outright: no second line for it.
  if (milestoneOf(item, env)) return [];
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
  return reping && !isAcked(reping, env.byId.get(item.id), env.activity) ? reping : null;
}

/** Friday: the open pipeline, and what nobody has touched for weeks. */
const stageStale: Rule = (item, env) => {
  if (!isFriday(env.today)) return [];
  const stage = item.stage;
  if (!stage || !env.policy.pipelineStages.includes(stage)) return [];
  const days = daysSince(item.updatedAt, env.today);
  if (days <= env.policy.stageStaleDays) return [];
  return [
    {
      itemId: item.id,
      reason: `• ${item.ref} ${item.title}: in ${stage}, no update for ${plural(days, "day")}`,
      section: "pipeline",
      ping: false,
      actions: [],
    },
  ];
};

/** Friday: a Learn-track item's cadence, and when it was last touched. */
const learnCadence: Rule = (item, env) => {
  if (!isFriday(env.today)) return [];
  if (item.track !== env.policy.learnTrack || !item.cadence) return [];
  // The item's own update only: a notes commit under its Account moves the
  // Learning line of every item of that Account, which made the age disagree
  // with what the board says.
  const lastDate = isoDate(item.updatedAt);
  const days = dayDiff(env.today, lastDate);
  const age = lastDate >= weekStart(env.today) ? "this week" : `${plural(days, "day")} ago`;
  return [
    {
      itemId: item.id,
      reason: `• ${item.ref} ${item.title}: cadence ${item.cadence}, last update ${fmtDate(lastDate)} (${age})`,
      section: "learning",
      ping: false,
      actions: [],
    },
  ];
};

// ---- E: the rules ------------------------------------------------------------

const targetToday: Rule = (item, env) => {
  if (!item.target || item.target !== env.today) return [];
  return [
    {
      itemId: item.id,
      reason: "*due today*: close it, or move the date with a reason",
      section: "today",
      ping: true, // every open item, whatever its status
      actions: targetActions(item, env),
    },
  ];
};

const morningUnacked: Rule = (item, env) => {
  if (!unackedMorningPing(item, env) || !sweepWorthy(item, env)) return [];
  return [
    { itemId: item.id, reason: "no update since this morning's ping", section: "today", ping: true, actions: actionsFor(item, env) },
  ];
};

/**
 * What the sweep can still act on: a Target date 0..staleDays days past, or a
 * Next touch due today or past. A due-in-N row has nothing new to say at 17:30,
 * and neither has a milestone heads-up or a chase.
 */
function sweepWorthy(item: Item, env: Env): boolean {
  if (item.target !== null) {
    const d = dayDiff(item.target, env.today);
    if (d <= 0 && d >= -env.policy.staleDays) return true;
  }
  return item.nextTouch !== null && dayDiff(item.nextTouch, env.today) <= 0;
}

/** This morning's ping of the item, if it got none. */
function unackedMorningPing(item: Item, env: Env): SentPing | null {
  const morning = env.history.find((h) => h.itemId === item.id && h.date === env.today && h.slot === "M");
  return morning && !isAcked(morning, env.byId.get(item.id), env.activity) ? morning : null;
}

const MORNING_RULES: Rule[] = [
  targetDue,
  nextTouchDue,
  milestone,
  waitingChase,
  targetSoon,
  targetStale,
  nextTouchTomorrow,
  unackedReping,
  stageStale,
  learnCadence,
];
const EVENING_RULES: Rule[] = [targetToday, morningUnacked];

// ---- Plan: rules, then one merge, then one render ---------------------------

interface ItemFindings {
  item: Item;
  findings: Finding[];
}

export interface PlanContext {
  /** Overrides any DEFAULT_POLICY knob. */
  policy?: Partial<Policy>;
  /** itemId -> ISO of the last notes-repo commit under the item's Account. */
  activity?: Map<string, string>;
  /**
   * The day's meetings, as meeting-pings.ts renders them (`• 09:00 Acme weekly
   * sync`): the one section of the briefing that is not about the board. The
   * morning reads them; the evening has no briefing to put them in.
   */
  meetings?: readonly string[];
}

export function plan(items: Item[], today: string, slot: Slot, history: SentPing[], ctx?: PlanContext): Plan {
  const policy: Policy = { ...DEFAULT_POLICY, ...ctx?.policy };
  const env: Env = {
    today,
    slot,
    history,
    byId: new Map(items.map((i) => [i.id, i])),
    policy,
    activity: ctx?.activity ?? new Map<string, string>(),
    index: new Map(items.map((item, at) => [item.id, at])),
  };
  const open = items.filter((i) => i.status !== policy.done);
  const rules = slot === "M" ? MORNING_RULES : EVENING_RULES;
  const view = open.map((item) => ({ item, findings: rules.flatMap((rule) => rule(item, env)) }));
  // The morning is one message: its rows are the briefing, not pings of their own.
  if (slot === "M") return { briefing: renderBriefing(view, env, workItems(items), ctx?.meetings ?? []), pings: [] };
  return { briefing: null, pings: mergePings(view, env) };
}

/** The buttons of the merged reasons, each one once, in the order the rules gave them. */
function mergeActions(pinged: Finding[]): ActionId[] {
  const ids: ActionId[] = [];
  for (const finding of pinged) {
    for (const id of finding.actions) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** One ping per item per slot, however many reasons fired; they are merged. */
function mergePings(view: ItemFindings[], env: Env): Ping[] {
  return view.flatMap((entry) => {
    const ping = mergePing(entry, env);
    return ping === null ? [] : [ping];
  });
}

/** One item's findings as one ping, or null when nothing in it pings. */
function mergePing({ item, findings }: ItemFindings, env: Env): Ping | null {
  const joiner = env.slot === "M" ? ", " : "; ";
  const pinged = findings.filter((f) => f.ping);
  if (pinged.length === 0) return null;
  return {
    key: pingKey(env.today, env.slot, item.id),
    itemId: item.id,
    // An evening ping that answers an unanswered morning ping is a re-ping.
    kind: env.slot === "E" && unackedMorningPing(item, env) ? "reping" : "ping",
    text: [`${link(item)}: ${pinged.map((f) => f.reason).join(joiner)}`, ...contextLines(item)].join("\n"),
    actions: mergeActions(pinged),
  };
}

/** The briefing's rows, one per item that needs action, in rowOrder. */
function briefingRows(view: ItemFindings[], env: Env): Ping[] {
  const rows = view.flatMap((entry) => {
    const ping = mergePing(entry, env);
    return ping === null ? [] : [{ ping, order: rowOrder(entry.item, env) }];
  });
  rows.sort((a, b) => compareOrder(a.order, b.order));
  return rows.map((row) => row.ping);
}

function renderBriefing(view: ItemFindings[], env: Env, work: readonly Item[], meetings: readonly string[]): Briefing {
  const policy = env.policy;
  const inSection = (name: Section): Finding[] => view.flatMap((v) => v.findings.filter((f) => f.section === name));

  // The sections above the rows: the title, then yesterday's warnings.
  const head: string[] = [`*Morning briefing, ${fmtDate(env.today)}*`];

  // Warnings keep the history's order, not the board's.
  const warn = inSection("warn").sort((a, b) => warnOrder(env, a) - warnOrder(env, b));
  if (warn.length > 0) head.push(warn.map((f) => f.reason).join("\n"));

  const rows = briefingRows(view, env);
  const today = rows.length > 0 ? ["*Today*", ...rows.map((row) => `• ${row.text}`)] : ["*Today*", "Nothing due. 🎉"];

  // The sections under the rows. The day's meetings go first: they are how the
  // day is shaped, and everything under them is about the board. A day with
  // nothing on it adds no heading at all, so the briefing cannot grow one that
  // says nothing every morning.
  const tail: string[] = [];
  if (meetings.length > 0) tail.push(`*Today's meetings*\n${meetings.join("\n")}`);

  const soon = view
    .flatMap((v) => v.findings.filter((f) => f.section === "soon").map((f) => `• ${link(v.item)}: ${f.reason}`));
  if (soon.length > 0) tail.push(`*Coming up*\n${soon.join("\n")}`);

  const stale = inSection("stale").map((f) => f.reason);
  if (stale.length > 0) tail.push(`*Stale dates* (more than ${policy.staleDays} days overdue, fix or close): ${stale.join(", ")}`);

  for (const [name, title] of [
    ["pipeline", "Pipeline"],
    ["learning", "Learning"],
  ] as const) {
    const lines = inSection(name).map((f) => f.reason);
    if (lines.length > 0) tail.push(`*${title}*\n${lines.join("\n")}`);
  }

  const working = work.filter((item) => item.status === policy.inProgress);
  const wip = working.length;
  if (wip > policy.wipLimit) {
    // Over the limit: name what is in flight, so dropping one is a choice.
    tail.push(
      `*In progress:* ${wip} (over the limit of ${policy.wipLimit}: what are you dropping?)\n${working.map((item) => item.ref).join(", ")}`,
    );
  } else {
    tail.push(`*In progress:* ${wip}`);
  }

  const text = [...head, today.join("\n"), ...tail].join("\n\n");
  // With no rows the Today header carries its own line; with rows the header
  // stands alone and each row is a block of its own, with a menu on it.
  return { text, head: [...head, rows.length === 0 ? today.join("\n") : "*Today*"], rows, tail };
}

function warnOrder(env: Env, finding: Finding): number {
  return env.history.findIndex((h) => h.itemId === finding.itemId && h.kind === "reping" && h.date === prevWorkday(env.today));
}
