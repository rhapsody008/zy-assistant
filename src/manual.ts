// The user manual: what the bot does, in the words it answers "help" with.
//
// The overview has two parts, "What you can type" and "What I send you", because
// the 0.4.1 overview listed the automatic messages next to the commands and ZY
// tried to type a ping. Then "help <topic>" opens the page behind a topic. Every
// number the text quotes is taken from the settings it is built with (the live
// policy and the two slot times), so the manual cannot drift from what the bot
// does. The note line and the note topic exist only when the scribe is on, the ask
// line and the ask topic only when a model is set, and the notes-repo ack line in
// "updates" only when NOTES_REPO is set: the manual describes this deployment, not
// every deployment.

import type { Policy } from "./rules.ts";
import { TZ } from "./time.ts";

/** The live setup the manual quotes: the two slot times and the policy. */
export interface ManualSettings {
  briefTime: string; // HH:MM, BRIEF_TIME
  eodTime: string; // HH:MM, EOD_TIME
  notesRepo: string | null; // NOTES_REPO: where the scribe writes, and what the ask reads
  /** True when the LLM variables are set: a DM may then hold a question. */
  ask: boolean;
  policy: Policy;
}

export interface ManualTopic {
  /** The word `help <topic>` asks for. */
  topic: string;
  /** The page's header, above its details. */
  title: string;
  /** `help <topic>`: one paragraph (or list) per string. */
  details: string[];
}

/** The one kind of block the manual needs: a section of mrkdwn. */
export interface ManualBlock {
  type: "section";
  text: { type: "mrkdwn"; text: string };
}

export interface ManualReply {
  text: string; // the plain rendering, also used as the message's fallback text
  blocks: ManualBlock[];
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

/** "Workshop", "a or b", "a, b or c". */
function words(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** "Workshop at T-14 and T-7, POC at T-14 and T-7": the milestone days, by type. */
function milestones(policy: Policy): string {
  return Object.entries(policy.leadByType)
    .map(([type, lead]) => `${type} at ${lead.milestones.map((days) => `T-${days}`).join(" and ")}`)
    .join(", ");
}

/** "14 days out for a Workshop or POC", or null when no type has a lead time. */
function leadNote(policy: Policy): string | null {
  const leads = Object.entries(policy.leadByType);
  if (leads.length === 0) return null;
  const heads = [...new Set(leads.map(([, lead]) => lead.heads))].sort((a, b) => a - b);
  return `${heads.join("/")} days out for a ${words(leads.map(([type]) => type))}`;
}

function todayTopic(settings: ManualSettings): ManualTopic {
  const policy = settings.policy;
  const [low, high] = policy.soonDays;
  const lead = leadNote(policy);
  const comingUp = `Target dates ${low}–${high} days away${lead === null ? "" : `, ${lead}`}, and a Next touch due tomorrow`;
  return {
    topic: "today",
    title: "Today",
    details: [
      `*When*: weekdays only, ${TZ}. The morning briefing goes out once at \`${settings.briefTime}\`, the wrap-up once at \`${settings.eodTime}\`. A slot runs at most once a day; one that fails is retried on the next minute tick, and after three failures I close the slot and DM you the error.`,
      [
        "*What the morning briefing holds*, in this order:",
        `• *Today*: an item whose Target date is today, due within ${plural(policy.pingDays, "day")} or already overdue, whose Next touch is due or past, or that is at a milestone. With nothing due it reads "Nothing due. 🎉".`,
        `• *Coming up*: ${comingUp}.`,
        `• *Stale dates*: Target dates more than ${plural(policy.staleDays, "day")} overdue, to fix or close.`,
        `• *Pipeline* and *Learning*, Fridays only: an open Stage item nobody has touched for more than ${plural(policy.stageStaleDays, "day")}, and a Learn-track item with its cadence and the date of its last update.`,
        `• *In progress: N*, the WIP count. Over the limit of ${policy.wipLimit} it names what is in flight and asks what you are dropping.`,
        "• A ⚠ line at the very top for a ping from the previous workday that never got an answer (see `help pings`).",
      ].join("\n"),
      `A ${policy.waiting} item shows up in Today like any other, and the chase rule that repeats the ask after ${plural(policy.waitingChaseDays, "day")} is in \`help pings\`.`,
      "`today` in a DM sends the plan for today as it would go out right now: the briefing first, then each ping it comes with. It writes nothing to the board and records nothing.",
    ],
  };
}

function pingsTopic(settings: ManualSettings): ManualTopic {
  const policy = settings.policy;
  return {
    topic: "pings",
    title: "Pings",
    details: [
      "Pings are messages I send you; you don't type them.",
      `*When a direct ping goes out*: in the morning, for an item that is ${policy.inProgress} or ${policy.waiting}, on any of these:`,
      [
        `• Target date T-${policy.pingDays} to T-0: due in ${plural(policy.pingDays, "day")} or fewer, and daily until the date, including the day it is due.`,
        `• Target date overdue: daily for up to ${plural(policy.staleDays, "day")}, and after that only the briefing's Stale dates line.`,
        `• A milestone: ${milestones(policy)}, whatever the item's status. Two weeks out is when the room gets booked.`,
        "• Next touch due today or past: daily until the date moves or the item is Done.",
        `• ${policy.waiting} with no Next touch and no update for more than ${plural(policy.waitingChaseDays, "day")}, and no ping of it in that window: the ping asks whether to chase whoever it waits on.`,
      ].join("\n"),
      "One message per item per slot: when several reasons fire they are merged into one ping, and so are their buttons.",
      `*End of day*, at \`${settings.eodTime}\`: a ping for every open item whose Target date is today (close it, or move the date with a reason), and a re-ping for every morning ping that still has no answer. A re-ping is what the next morning's ⚠ line counts.`,
      "A ping stops being re-pinged the moment it is acked: see `help updates` for what counts.",
    ],
  };
}

function buttonsTopic(settings: ManualSettings): ManualTopic {
  const policy = settings.policy;
  return {
    topic: "buttons",
    title: "Buttons",
    details: [
      "Every ping has buttons under it: one message about ONE item, with its link, why it is due, and the buttons. Only your clicks count, and a click is the approval: I write to the board at once.",
      [
        `• *👍 On it*: nothing on the board changes. The ping is marked handled and the buttons are replaced by "→ acked". That is all it does.`,
        `• *✅ Done*: sets the item's Status to \`${policy.done}\`, then closes the ping.`,
        "• *Tomorrow*: sets Next touch to tomorrow, rolled off the weekend, so a Friday becomes Monday. The Target date is untouched.",
        "• *+7 days*: sets Next touch to 7 days from today, rolled off the weekend the same way.",
      ].join("\n"),
      [
        "*Move date*: opens a form with the item's Target date already in it, and a reason that cannot be left empty. Submitting it:",
        "• sets Target date to the date you picked;",
        "• comments `Target date moved <old> → <new> by zy-assistant: <reason>` on the issue. A draft has no issue, so that line goes in the ping's thread instead;",
        "• closes the ping.",
        "The date is written first: if the comment fails, the thread says so and the move still counts; if the date write fails, nothing moved and the ping keeps its buttons.",
      ].join("\n"),
      "Which buttons a ping has: a ping about a Target date has *👍*, *Move date* and *✅*. A ping about a touch or a chase has no *Move date* (there is no date line to move). *Tomorrow* and *+7 days* appear on any ping whose Next touch is already due.",
      'A plain reply in a ping\'s thread acks it, and answers "Noted." A failed board write leaves the buttons under the message with `→ failed: …`, so the click can be retried.',
    ],
  };
}

function noteTopic(settings: ManualSettings): ManualTopic {
  return {
    topic: "note",
    title: "Notes",
    details: [
      "Type `note:` and then the dictation, as a DM or as a reply in a ping's thread. Dictated under a ping, the item's title goes to the model as context, and the note does not ack the ping.",
      [
        "*What happens*: the raw text is stored first, then the model structures it, and the entry is committed at the top of the `Log` in `<folder>/README.md`:",
        "`## <date> · <type> · <topic>`, then attendees and summary, then decisions, then an `### Actions` list.",
      ].join("\n"),
      `The model picks the folder from the ones \`${settings.notesRepo ?? "the notes repo"}\` has. When none of them fits it suggests \`Accounts/<name>\`, and I ask: *Create*, one of the existing folders, or *Cancel*. An account I have never seen ends in that question, not in a guess.`,
      "If the model cannot answer at all, the raw words are committed verbatim and quoted, once you choose the folder.",
      'Dates: "this Friday" is the coming Friday, and "next Friday" is the Friday of the following week, 7 days after that one. The same for every other weekday.',
      "Not yet: the note's actions are listed in the reply, but nothing goes to the board. Board proposals come in step 2.",
    ],
  };
}

function askTopic(settings: ManualSettings): ManualTopic {
  const reads =
    settings.notesRepo === null
      ? "• the notes: nothing, twice over. Without `NOTES_REPO` there is no notes repo to read, so the answer is the board alone."
      : `• the notes: the README of up to three folders your question names, its header and the newest part of its log, from \`${settings.notesRepo}\`.`;
  return {
    topic: "ask",
    title: "Questions",
    details: [
      'Ask me a question in the DM and I answer it from the board and your notes: `how\'s the Acme POC going?`, `what\'s waiting on others?`, `what did we decide about the Globex sizing?`. My answer comes in the thread under your question.',
      [
        "*What I read*, every time:",
        "• the board: every item that is not Done, plus the Done items touched in the last two weeks, the most recently updated first, at most 150 lines;",
        reads,
      ].join("\n"),
      "I answer only from what I read. When the board has no item for what you asked, or the notes stop before the date you mean, I say so and say what is missing, rather than guess. Every date, name and status I write comes from there.",
      "It is read-only. Nothing is written to the board or to the notes, no button is pressed, and I have no tools: the worst that can happen is a wrong answer.",
      "A follow-up goes in the same thread: I rebuild from the fresh board and notes, and I keep the last few questions of that thread in mind. Without a model (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`) there is nothing to ask, and a DM that is no command answers with the one-line hint.",
    ],
  };
}

function updatesTopic(settings: ManualSettings): ManualTopic {
  const acks = [
    "• a button under the ping (see `help buttons`);",
    "• a plain reply in the ping's thread;",
    "• the board item changing after the ping: its status, its dates or its title, or a comment on its issue;",
    ...(settings.notesRepo === null
      ? []
      : ["• a commit to the notes repo under `Accounts/<the item's Account>/`, which is why a `note:` about an account can quiet that account's items."]),
  ];
  return {
    topic: "updates",
    title: "Updates",
    details: [
      "A ping stops being re-pinged as soon as it is acked (ack = mark as seen). A ping is acked by any of these:",
      acks.join("\n"),
      "The clock is the part that matters: only a change after the ping counts, so an item touched last week does not silence this morning's ping. A board change or a notes commit is read as an update on the item itself, however small.",
    ],
  };
}

/** The topics this deployment has, in manual order: "note" only with the scribe on,
 * "ask" only with a model to ask.
 */
export function manualTopics(settings: ManualSettings, scribe: boolean): ManualTopic[] {
  return [
    todayTopic(settings),
    pingsTopic(settings),
    buttonsTopic(settings),
    ...(scribe ? [noteTopic(settings)] : []),
    ...(settings.ask ? [askTopic(settings)] : []),
    updatesTopic(settings),
  ];
}

const section = (text: string): ManualBlock => ({ type: "section", text: { type: "mrkdwn", text } });

/** The overview's first part: the few things you type, one line each. */
function typedBlock(settings: ManualSettings, scribe: boolean): ManualBlock {
  return section(
    [
      "*What you can type*",
      "• `today`: the plan for today, the same view as the morning briefing.",
      ...(settings.ask
        ? [
            "• Ask me anything about your board or notes, e.g. `how's the Acme POC going?` or `what's waiting on others?` I answer from the board and your notes, and I never change anything.",
          ]
        : []),
      ...(scribe ? ["• `note: <text>`: `note: Acme call, they want a POC in January. I send the sizing by Friday.` and I save it to the notes repo."] : []),
      "• `help`, or `help <topic>`: this manual, or the page behind one topic.",
      "• Reply under a ping: marks it seen.",
      ...(settings.ask ? ["• Anything else you write, in a new message or a thread, is read as a question."] : []),
    ].join("\n"),
  );
}

/** The overview's second part: what arrives on its own. Nothing here is a command. */
function sentBlock(settings: ManualSettings): ManualBlock {
  const policy = settings.policy;
  return section(
    [
      "*What I send you* (automatic; you never type these)",
      `• The briefing at \`${settings.briefTime}\` and the wrap-up at \`${settings.eodTime}\` on weekdays: one message listing everything.`,
      `• Pings: a separate message about ONE item when it needs you now: a deadline close (Target date due in ${plural(policy.pingDays, "day")} or fewer) or already passed, a Next touch due, or someone to chase (a ${policy.waiting} item nobody moved for ${plural(policy.waitingChaseDays, "day")}). Each ping has buttons.`,
      "• A ping looks like this: `notes#53 Acme deck review: due in 2 days (Thu 26 Nov)  [👍 On it] [Move date] [✅ Done]`",
    ].join("\n"),
  );
}

/** The buttons, one line each on what they change on the board. */
function buttonBlock(policy: Policy): ManualBlock {
  return section(
    [
      "*The buttons under a ping*",
      "• *👍 On it*: nothing on the board changes; the ping is only marked handled.",
      `• *✅ Done*: sets the item's Status to \`${policy.done}\`.`,
      "• *Move date*: asks for the new date and a reason, sets Target date, and posts the reason on the issue.",
      "• *Tomorrow* and *+7 days*: move Next touch, rolled off the weekend. The Target date stays.",
    ].join("\n"),
  );
}

/** The last line of the overview: where each page is. */
function moreBlock(topics: ManualTopic[]): ManualBlock {
  const has = (topic: string): boolean => topics.some((t) => t.topic === topic);
  const pages = ["pings", "buttons", ...(has("note") ? ["note"] : []), ...(has("ask") ? ["ask"] : []), "updates", "today"];
  return section(`More: ${pages.map((topic) => `\`help ${topic}\``).join(", ")}`);
}

/** The overview: what you type, what I send you, the buttons, then where the pages are. Pure. */
export function overviewBlocks(settings: ManualSettings, scribe: boolean): ManualBlock[] {
  return [typedBlock(settings, scribe), sentBlock(settings), buttonBlock(settings.policy), moreBlock(manualTopics(settings, scribe))];
}

/** The overview as plain text: what a README or a log prints. The same words. */
export function overviewText(settings: ManualSettings, scribe: boolean): string {
  return overviewBlocks(settings, scribe)
    .map((block) => block.text.text)
    .join("\n\n");
}

/**
 * The topic a `help <topic>` names, or null. `briefing` is what the `today` page
 * was called before 0.4.2: it still opens it, and the manual never names it.
 */
function findTopic(topics: ManualTopic[], asked: string): ManualTopic | null {
  const word = asked.trim().toLowerCase();
  return topics.find((topic) => topic.topic === (word === "briefing" ? "today" : word)) ?? null;
}

/**
 * What "help", "?" or "manual" answers, with a topic or without one. A topic the
 * bot does not have is the overview with the miss said on top, not an error.
 */
export function helpReply(settings: ManualSettings, scribe: boolean, asked: string | null): ManualReply {
  const topics = manualTopics(settings, scribe);
  const wanted = asked === null ? null : findTopic(topics, asked);
  const blocks =
    wanted === null
      ? [...(asked === null ? [] : [section(`No topic \`${asked}\`. Here is the overview.`)]), ...overviewBlocks(settings, scribe)]
      : [section(`*${wanted.title}*`), ...wanted.details.map(section)];
  return { text: blocks.map((block) => block.text.text).join("\n\n"), blocks };
}
