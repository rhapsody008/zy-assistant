// Deterministic reminder rules (zy-ops#7). Pure: no I/O, no clock.
//
// Slots: M = morning briefing, E = end-of-day sweep (weekdays only; the scheduler decides).
// M: one briefing message, plus a direct ping for every In-progress item that needs action:
//    - Target date today, or 1..pingDays days away (deadline ladder; always fires in T-3..T-1)
//    - Target date passed by 1..staleDays days (overdue, daily)
//    - Next touch today or passed (daily until the date moves or the item is Done)
//    - A Work type with a lead time: exactly on a milestone day (T-heads, T-7 for a
//      Workshop or a POC), whatever the status, so the prep starts two weeks out
//    - Status Waiting, no Next touch at all, no update for waitingChaseDays, and
//      no ping of the item within those same waitingChaseDays
//    Items that are not In progress and match a date or touch rule go into the
//    briefing's "Today" list instead; a milestone always pings.
//    Target soonDays (4..7, or up to the Work type's heads) away -> "Coming up" line.
//    Overdue > staleDays -> one "Stale dates" line. An E re-ping from the previous
//    workday that is still unacked -> ⚠ line at the top.
//    Friday only: a "Pipeline" line per open Stage item nobody touched for
//    stageStaleDays, and a "Learning" line per Learn-track item with a cadence.
// E: a ping for each open item whose Target date is today ("close it or move the date"),
//    and one re-ping for each M ping from today that has no ack.
// Ack = a button press, a thread reply, the item updated (board or issue) after the
// ping, or a notes-repo commit under the item's Account after the ping.
// One message per item per slot; reasons are merged, and so are their buttons.
// WIP: an item with sub-issues on the board is a parent, an engagement rather than
// a unit of work, so the In progress count and its list leave it out (workItems).
//
// Shape: every rule is a pure function (item, env) => Finding[]. Each item goes
// through the rules of its slot in board order, then one merge step turns an
// item's findings into at most one Ping, then one render step turns the morning
// findings into the briefing text. Policy is data: the defaults are the rules
// above, and a caller may override any of them.

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

export interface Plan {
  briefing: string | null;
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
  if (d === 0) return [todayFinding(item, env, "*due today*", actions)];
  if (d >= 1 && d <= env.policy.pingDays) return [todayFinding(item, env, `due in ${plural(d, "day")} (${fmtDate(target)})`, actions)];
  if (d < 0 && d >= -env.policy.staleDays) return [todayFinding(item, env, `*overdue* by ${plural(-d, "day")} (target ${fmtDate(target)})`, actions)];
  return [];
};

const nextTouchDue: Rule = (item, env) => {
  const nextTouch = item.nextTouch;
  if (!nextTouch) return [];
  const d = dayDiff(nextTouch, env.today);
  if (d > 0) return [];
  return [todayFinding(item, env, d === 0 ? "touch today" : `touch was ${fmtDate(nextTouch)}`, actionsFor(item, env))];
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
  if (item.status !== env.policy.waiting) return [];
  // Any Next touch wins: a due one pings on its own, a future one means
  // "leave it until then".
  if (item.nextTouch !== null) return [];
  if (daysSince(item.updatedAt, env.today) <= env.policy.waitingChaseDays) return [];
  // A ping that went out within the window is a chase already made: repeating it
  // every morning until someone answers is noise, not a reminder.
  if (pingedRecently(item, env)) return [];
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

/** True when the item was pinged at all within the last waitingChaseDays days. */
function pingedRecently(item: Item, env: Env): boolean {
  return env.history.some((h) => h.itemId === item.id && daysSince(h.sentAt, env.today) <= env.policy.waitingChaseDays);
}

/** In progress or Waiting: a ping. Anything else: only the briefing line. */
function todayFinding(item: Item, env: Env, reason: string, actions: ActionId[]): Finding {
  const ping = item.status === env.policy.inProgress || item.status === env.policy.waiting;
  return { itemId: item.id, reason, section: "today", ping, actions: ping ? actions : [] };
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
  if (!unackedMorningPing(item, env)) return [];
  return [
    { itemId: item.id, reason: "no update since this morning's ping", section: "today", ping: true, actions: actionsFor(item, env) },
  ];
};

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
  };
  const open = items.filter((i) => i.status !== policy.done);
  const rules = slot === "M" ? MORNING_RULES : EVENING_RULES;
  const view = open.map((item) => ({ item, findings: rules.flatMap((rule) => rule(item, env)) }));
  return {
    briefing: slot === "M" ? renderBriefing(view, env, workItems(items)) : null,
    pings: mergePings(view, env),
  };
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
      actions: mergeActions(pinged),
    });
  }
  return pings;
}

function renderBriefing(view: ItemFindings[], env: Env, work: readonly Item[]): string {
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

  for (const [name, title] of [
    ["pipeline", "Pipeline"],
    ["learning", "Learning"],
  ] as const) {
    const lines = inSection(name).map((f) => f.reason);
    if (lines.length > 0) parts.push(`*${title}*\n${lines.join("\n")}`);
  }

  const working = work.filter((item) => item.status === policy.inProgress);
  const wip = working.length;
  if (wip > policy.wipLimit) {
    // Over the limit: name what is in flight, so dropping one is a choice.
    parts.push(
      `In progress: ${wip} (over the limit of ${policy.wipLimit}: what are you dropping?)\n${working.map((item) => item.ref).join(", ")}`,
    );
  } else {
    parts.push(`In progress: ${wip}`);
  }

  return parts.join("\n\n");
}

function warnOrder(env: Env, finding: Finding): number {
  return env.history.findIndex((h) => h.itemId === finding.itemId && h.kind === "reping" && h.date === prevWorkday(env.today));
}
