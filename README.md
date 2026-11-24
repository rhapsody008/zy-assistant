# zy-assistant

A Slack DM bot that reminds ZY what the GitHub Project board says to do today.

It reads a GitHub Project v2 board, applies the rules in `src/rules.ts`, and DMs
the result at two slots on weekdays (Asia/Singapore):

- **M**, `BRIEF_TIME` (09:00): one morning briefing. Its *Today* rows are the
  items that need action, whatever their status (Target date within 3 days,
  overdue, or Next touch due; a Workshop or a POC two weeks and one week out; a
  Waiting item nobody touched for a few days). Each row (up to the message limit) carries a ⋯ menu with the
  ping actions, and the rows are sorted: late first, then due or touch today, then
  soonest, chases, heads-ups. Friday adds a Pipeline and a Learning section.
- **E**, `EOD_TIME` (17:30): a ping for every item whose Target date is today, and
  a re-ping for every morning row that was never acked and is late or due/touch
  today. A quiet evening sends nothing.

A slot runs at most once. If Slack fails half way through, the next minute tick
retries and sends only what never went out (the morning briefing included), and
after three failures it closes the slot and DMs the error.

A row or ping is acked by its menu or buttons, a reply in an evening ping's thread, updating the
item on the board, or committing to `Accounts/<Account>` in the notes repo.
Buttons write to the board (ZY's click is the approval): 👍 On it (ack),
Move date (a modal: a new date and a reason, which becomes a comment on the
issue), ✅ Done (Status = Done), Tomorrow / +7 days (Next touch, rolled off the
weekend).

The board is mapped by field **name**: `Status` (single select), `Target date`,
`Next touch` (dates), `Next action`, `Waiting on` (text). Closed or merged
content counts as `Done`. The optional fields `Work type`, `Stage`, `Track`,
`Account` and `Cadence` are read when the board has them: Work type sets the lead
time, Stage and Track feed the Friday sections, Cadence is what the Learning
section reports, and Account is where the notes-repo activity is looked up.

It also answers questions: DM it `how's the Acme POC going?` and it reads the
board and the notes repo and answers in a thread, changing nothing (see
**Asking questions**). And it takes dictations: DM `note: …` and the scribe turns
it into an entry of the notes repo and replies with the link (see **The scribe**).

## Using the bot

DM the bot `help` (or `?`, or `manual`) and it answers with the manual below,
which separates what you type from what the bot sends on its own. `today`
previews the morning plan, `help <topic>` opens one topic, and an unknown topic
answers the overview with `No topic <x>.` on top. Any other DM that is no command
is a question when the LLM is set (see **Asking questions**), and a one-line hint
when it is not. The ask line and the `ask` topic are left out when there is no
model. The text is rendered from `src/manual.ts` with the live
policy and slot times (`WAITING_CHASE_DAYS`, `STAGE_STALE_DAYS`, the lead times,
the WIP limit), so the pages say what this deployment does. The `note:` line and
the `note` topic are left out when the scribe is off, the `add:` line and the
`add` topic when `ADD_REPO` is unset, and the notes-repo ack below when
`NOTES_REPO` is unset. With the defaults, `help` sends exactly this:

```
*What you can type*
• `today`: the plan for today, the same text as the morning briefing.
• Ask me anything about your board or notes, e.g. `how's the Acme POC going?` or `what's waiting on others?` I answer from the board and your notes, and I never change anything.
• `note: <text>`: `note: Acme call, they want a POC in January. I send the sizing by Friday.` and I save it to the notes repo.
• `help`, or `help <topic>`: this manual, or the page behind one topic.
• Reply under an evening ping: marks it seen.
• Anything else you write, in a new message or a thread, is read as a question.

*What I send you* (automatic; you never type these)
• The briefing at `09:00` on weekdays: ONE message, with a row per item that needs you and a `⋯` menu on each row.
• At `17:30`, only if something needs you: a ping for each item due today, and a re-ping of an unanswered row that is still late or still due. A quiet evening sends nothing.
• The pings of the evening are a separate message about ONE item: a deadline close (Target date due in 3 days or fewer) or already passed, a Next touch due, or someone to chase (a Waiting item nobody moved for 5 days). Each ping has buttons.
• A row looks like this: `notes#53 Acme deck review: due in 2 days (Thu 26 Nov)` with `⋯` on its right: *Got it*, *Done*, *+1 day*, *+7 days*, *Move date…*

*The buttons under a ping, and the `⋯` on a row*
• *👍 On it*: nothing on the board changes; the ping is only marked handled.
• *✅ Done*: sets the item's Status to `Done`.
• *Move date*: asks for the new date and a reason, sets Target date, and posts the reason on the issue.
• *Tomorrow* and *+7 days*: move Next touch, rolled off the weekend. The Target date stays.
• A row's `⋯` menu has the same actions, one entry each: *Got it*, *Done*, *+1 day*, *+7 days*, *Move date…*

More: `help pings`, `help buttons`, `help note`, `help ask`, `help updates`, `help today`
```

With `ADD_REPO` set, the typed block also carries the `add: <text>` line, and
`help add` opens its page.

Every successful action is one log line with ids only, never a note's text or
title: `scribe <ts>: committed in <ms> ms (<n> actions) <url>`,
`scribe <ts>: asked for a folder`, `scribe <ts>: committed raw text <url>`,
`add <ts>: drafted in <ms> ms (parent <ref>)`,
`add <ts>: created <repo>#<n> as <itemId>, under <parentItemId>`,
`add <ts>: create failed at <issue|project|fields|link>: <reason>`,
`note-items <ts>: proposed <n> items (<k> not created, parent <ref>)`,
`note-items <ts>: item <n>: created <repo>#<n> as <itemId>, under <parentItemId>`,
`note items: on -> <ADD_REPO>` (and `note items: off, a note's actions are only listed`
at startup), `calendar: on, <path>: snapshot <iso>, <n> events`, `calendar: snapshot
<iso>: <n> events, <n> all-day`, `calendar: snapshot rejected: <field path>: <why>`,
`calendar: <fresh|stale|expired>, snapshot <iso> (age <n>)`, `calendar: the tick failed: <why>`,
`proposal <id>: apply failed`, `button <action> on <item> by <user>`,
`move <item>: <old> -> <new>`, `reply ack <item>`, `help <topic>`,
`ask <ts>: answered in <ms> ms (<n> items, notes: <folders>)` and
`ask <ts>: failed: <reason>`. A question's text and an answer's text are never
logged, and neither is an `add:` sentence or the title drafted from it.

## Env

| Variable | Needed by | Default |
| --- | --- | --- |
| `GITHUB_TOKEN` | every mode | – (fine-grained PAT: read the project, write the items, and Issues read and write on `ADD_REPO`) |
| `SLACK_BOT_TOKEN` | `run`, optional `check` | – |
| `SLACK_APP_TOKEN` | `run`, optional `check` | – |
| `SLACK_USER_ID` | `run`, optional `check` | – (the only person the bot DMs and obeys) |
| `PROJECT_OWNER` | | `rhapsody008` |
| `PROJECT_NUMBER` | | `1` |
| `BRIEF_TIME` | | `09:00` |
| `EOD_TIME` | | `17:30` |
| `DB_PATH` | | `./data/state.db` |
| `ASSISTANT_TZ` | | `Asia/Singapore` |
| `NOTES_REPO` | | – (owner/repo: a commit under `Accounts/<Account>` acks that Account's items, the scribe writes here and the ask reads here; unset turns all three off) |
| `ADD_REPO` | `run` | – (owner/repo: where an `add:` item's issue is created; with the three `LLM_*` variables it turns `add:` on) |
| `NOTE_ITEMS` | `run` | – (`on`: a committed note's actions are offered as board items; any other value is off. It needs the scribe and `ADD_REPO`, and without either it is a startup error) |
| `CALENDAR_FILE` | `run`, `calendar` | – (an absolute path to the calendar snapshot the Mac pushes as a ConfigMap; unset turns the calendar off) |
| `WAITING_CHASE_DAYS` | | `5` (a Waiting item with no update for longer is chased) |
| `STAGE_STALE_DAYS` | | `21` (a pipeline item with no update for longer is nagged on Friday) |
| `LLM_BASE_URL` | `scribe`, `ask`, `check`, `run` | – (an OpenAI-compatible gateway, e.g. `https://<host>/enterpriseai/gateway/v1`) |
| `LLM_API_KEY` | `scribe`, `ask`, `check`, `run` | – |
| `LLM_MODEL` | `scribe`, `ask`, `check`, `run` | – (e.g. `zy-pi-uep`) |
| `LLM_TIMEOUT_MS` | | `90000` (what one completion may take) |
| `NOTES_GITHUB_TOKEN` | | – (defaults to `GITHUB_TOKEN`; it is the token that needs contents write on `NOTES_REPO`) |

No token is ever logged or written to the database.

## Modes

```sh
node src/main.ts check                                   # board summary + Slack hello DM
node src/main.ts dry-run --date 2026-11-25               # print M and E for that day
node src/main.ts dry-run --date 2026-11-25 --slot M      # just the morning
node src/main.ts dry-run --week 2026-11-23               # Mon-Fri, M and E (a Monday)
node src/main.ts scribe --dry-run < note.txt             # a dictation: print the folder and the entry
node src/main.ts scribe < note.txt                       # a dictation: commit it
node src/main.ts ask "how's the Acme POC going?"         # a question: the answer and its sources
node src/main.ts calendar                                # the calendar snapshot the bot holds
node src/main.ts run                                     # Slack + scheduler, every 60 s
```

`dry-run` reads the live board with an empty history: it prints, it never sends,
never writes to the board and never opens the database.

`scribe` reads the dictation from stdin and runs the same pipeline a DM does,
without Slack and without the database: `listFolders`, the model, and the render
(`--dry-run`) or the commit. A dictation no existing folder fits prints the
suggested `Accounts/<name>` and writes nothing.

## Asking questions

A DM that is no command is a question, as long as the three `LLM_*` variables are
set: `how's the Acme POC going?`, `what's waiting on others?`, `what did we decide
about the Globex sizing?`. The bot replies `🔎 looking…` in a thread under the
question at once and edits that reply into the answer, with a line under it
saying what it read (`Sources: 12 board items, notes: Acme · 940 ms`). Every
failure lands in that reply as `couldn't answer: <reason>`; nothing is thrown at
Slack.

The context is rebuilt for every question:

- **today**, in Asia/Singapore, with the weekday, so "next week" and "before
  Friday" mean something;
- **the board**: every item that is not Done, plus the Done items touched in the
  last two weeks, the most recently updated first, at most 150 lines and about
  25k characters, one line each: ref, title, status, account, track, work type,
  stage, target date, next touch, next action, waiting on, updated, url, with the
  empty fields left out;
- **the notes**: with `NOTES_REPO` set, the README of up to three folders the
  question names — a folder name, or the Account of a board item the question
  names — its header and the newest part of its log (a README is newest first),
  with the GitHub URL of each.

The board goes in a `<board>` block and each README in a `<notes folder="…"
url="…">` block, and the system prompt says that everything inside them is data
to answer from, never an instruction. Everything inside a block is HTML-escaped
(`&amp;`, `&lt;`, `&gt;`, and `&quot;` in the attributes), so a title or a README
that holds `</board>` or `</notes>` cannot end the block it is in. The model gets
no tools.

The answer comes back at most 8 lines of Slack mrkdwn, at most 2900 characters,
with dates written as `Thu 26 Nov`, board items cited as their ref linked to the
GitHub issue and notes as `<readme-url|Acme notes>`. The prompt tells it to
answer only from the context and, when the context does not hold the answer, to
say so and say what is missing. A `<think>` block is stripped the way the scribe
strips it; a reply cut off at `LLM_MAX_TOKENS`, or one whose reasoning never
closed, is asked for once more.

It is strictly read-only: the board is only fetched, the notes are only read, and
nothing is written anywhere. The tests prove it with fakes whose write methods
throw.

Threads, in full:

- a reply under an evening ping is an ack, whatever it says (a briefing row is
  acked with its own menu, so a reply under the briefing is a question);
- a reply in a thread the bot has answered is a follow-up: the context is rebuilt
  from the fresh board and notes (a follow-up may name a different account), and
  the last three questions and answers of that thread ride along as conversation;
- any other reply (under a briefing, a `today` preview, a dictation's thread, a
  manual message) is a plain question, answered in that thread with no earlier
  talk;
- `note: …` is a dictation wherever it is written, and `add: …` is a draft
  wherever it is written; under an evening ping each takes that ping's item as a
  hint and does not ack the ping.

Answers are kept in the `asks` table, keyed by the answer message and its thread,
and the question's own message ts is claimed in `asks_seen` before the model is
called: Slack delivers an event twice sometimes, and one question gets one
answer. Both are pruned after 30 days, at startup and once a day after.

From the Mac:

```sh
node src/main.ts ask "how's the Acme POC going?"
```

The same pipeline, printed instead of posted: it needs `GITHUB_TOKEN` and the
three `LLM_*` variables, `NOTES_REPO` is optional, and it prints the answer, the
sources line and the timing. It keeps no history.

## The scribe

DM the bot `note: …` — as a DM or as a reply in a ping's thread — and it turns
the words into one entry of the notes repo, commits it without asking, and
replies in the same thread with the link. Dictated under a ping, the ping's item
title is given to the model as context; it does not ack the ping.

It is off unless `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` and `NOTES_REPO` are
all set: with any of them unset the bot behaves as 0.3.0 did, apart from the help text.
Half-set LLM variables are a startup error, not a quiet no.

The model is Nutanix Enterprise AI (`…/enterpriseai/gateway/v1`, model
`zy-pi-uep`): plain chat completions with `temperature: 0`, no `response_format`
and no tool calling, because the gateway need not have them. The answer is one
JSON object, taken out of the reply's `<think>` block and code fences, parsed and
validated; an unusable answer is sent back once more with the reason, and then
given up on.

What it does with a dictation:

1. replies `📝 writing…` in the thread, and stores the raw text in SQLite before
   anything else (the message `ts` is the key: a redelivered event does nothing);
2. lists `Accounts/`, `Partners/` and `Events/` and asks the model for
   `{ folder, newFolderName, date, type, topic, attendees, summary, decisions, actions }`;
3. a folder the model picks from that list is used as it is; when none fits it
   asks `New folder Accounts/<name>?` with a **Create** button, a **Cancel** and
   a select of the existing folders, and the answer resumes from the stored note
   (the model is not asked again);
4. reads the folder's `README.md` (or makes one) and inserts the entry directly
   under its `## Log` line, newest first, then commits it as
   `notes(<folder>): <date> <topic> [scribe]`; a README that changed under it is
   read again, up to three times;
5. edits the `📝 writing…` reply to `✅ <folder>: <topic> → <link>`, plus the
   note's actions with "board items: a card follows" when `NOTE_ITEMS` is on, and
   with "board proposals: coming in step 2" when it is not.

If the model cannot answer at all, nothing is lost: the raw text is offered the
existing folders and committed verbatim as
`## <today> · Meeting · Raw dictation (unprocessed)` with the text quoted, once
the folder is chosen. Until then the dictation stays in the `dictations` table
with the error that stopped it.

Format v0 of an entry:

```markdown
## 2026-11-25 · Workshop · Acme VPC sizing

**Attendees:** ZY, Ana
**Summary:** Two to five sentences.
**Decisions:**
- Ten nodes

### Actions
- [ ] ZY: send the sizing sheet (due 2026-11-28)

_Scribed by zy-assistant from Slack._
```

`Attendees`, `Decisions` and `### Actions` are left out when they are empty. The
actions are also stored (in the dictation's `note_json`) and listed in the reply.
With `NOTE_ITEMS` on they are then offered as board items on a card (see **Board
items from a note**); without it they stay that list, and nothing goes to the
board.

The Slack handler returns before the work starts and every error becomes a
thread reply, so Slack's three-second budget is never the scribe's problem. The
deployment's secret does not carry the LLM variables yet: the pod runs with the
scribe off, by design.

## Adding items

DM the bot `add: call Dana about the renewal on 8 Dec` and it drafts ONE board
item from that sentence. It replies `✍️ drafting…` at once and edits that same
message into a card: the title, the engagement it would go under, Account,
Track, Work type, Status, Target date, Next touch, Next action, a line saying
where the proposal stands, and **Create**, **Edit**, **Cancel** under it.

Nothing is written while the card is only a card. **Create** is what writes, and
the click is the approval.

Like `note:`, an `add:` is read wherever the DM holds it, in a new message or in
a thread. Typed under an evening ping, the ping's item goes to the model as a
hint, and the `add:` does not ack the ping.

**Create** writes four things, in this order:

1. an issue in `ADD_REPO`, whose body is your sentence quoted, with the day it
   came from Slack under it and a hidden marker a retry finds it by;
2. that issue onto the board;
3. the item's fields: Account, Track, Work type, Status, Target date, Next touch,
   Next action;
4. the new issue as a sub-issue of the parent engagement, when the draft has one.

Each step's result is saved to the proposal before the next one starts, so a
failure after the issue exists says so on the card and offers **Retry** in place
of Create: the retry continues from the step that failed, and no second issue is
ever made. A create whose answer never came back says the issue may exist, and
**Retry** looks for its marker before it creates anything. The card names the
step (`adding it to the board`, `writing its fields`, `linking it under its
parent`) and links the issue that already exists. The draft's option names and
its parent's ref are resolved against the board as the click finds it, and all
of them before anything is created, so a board that changed under a draft fails
with nothing written rather than a stray issue; once the issue exists only the
steps that are left are resolved, so an option renamed afterwards does not block
a retry that has nothing left to write with it.

**Edit** opens a modal over the card with all nine fields in it: Title, Parent
engagement, Account, Track, Work type, Status, Target date, Next touch, Next
action. Saving it redraws the card (with `Edited.` in front of the line that
says what Create would do) and writes nothing; Create is still the last click.

Dates are worked out from today with the rule the notes use: "this Friday" is
the coming Friday, "next Friday" is the Friday of the following week. The Target
date is the day the thing happens or is due (`on 8 Dec`, `by Friday`); the Next
touch is a follow-up you name for yourself (`chase on Monday`, `next week`).

A task title starts with a verb and names the result, and does not repeat the
account; an engagement is `<Name> · <what it's about>`. The parent is matched
from the board's engagements: the open items that already have tasks, or whose
title carries that ` · `. When none of them fits the card says
`⚠ No engagement matched`, and `⚠ No parent, no account` when there is no
Account either: Edit to set them, or Create it as a standalone item. A model
that cannot answer at all is not a lost sentence: the card says
`⚠ The model didn't answer`, the title is the sentence exactly as typed, and the
other eight fields are yours to fill in with Edit.

With `ADD_REPO` unset, `add:` is off: an `add: …` DM is read as a question when
the model is set, the way a `note: …` is read when the scribe is off, and the
`add:` line and topic are left out of the manual. `ADD_REPO` set without the
three `LLM_*` variables is a startup error, not a silently-off feature: there is
nowhere for the repo to go without a model, and a typo in the other direction
should not look like a working bot. The token needs Issues read and write on
`ADD_REPO` and the project's write access it already has; nothing is written to
the board until Create.

## Board items from a note

With `NOTE_ITEMS=on`, a committed note's actions become ONE card, in the thread
of the dictation, right after the commit: up to six items, one line each.

*How the note's actions are read*: each action is `- [ ] <owner>: <text> (due
<date>)`. An action of ZY's becomes **Next** with a Target date, because it is a
date he owes. Anyone else's becomes **Waiting**, with that person as the
waiting-on and the date as the Next touch, because it is the day he chases it:
the deadline rules must never nag ZY for another person's deliverable. An action
whose words already name a board item is left out (`<ref> is already on the
board`), and a date that is already past is left off the item's own dates, so
nothing puts a target in the past. The account is the note's folder
when it is `Accounts/<name>`, and the item hangs under that account's engagement
when the board has one: nothing here asks a model.

*Create* writes four things per item, in the note's order: an issue in
`ADD_REPO` whose body quotes the note's own action line and links the note, that
issue onto the board, the item's fields, and the item as a sub-issue of its
engagement. Each item's steps are saved as they land, so a failure part-way says
so on the card and offers **Retry**, which carries on from the item it stopped at
and never makes a second issue: an item that fails does not stop the ones after
it, and Retry continues with whichever are left.

*Edit* opens a modal over the card: the parent engagement of the whole batch, and
for each item what it becomes (Next, Waiting or Don't create), its title, and its
date. Saving it re-parents and redraws the card; nothing is written until
*Create*, exactly as with `add:`.

`NOTE_ITEMS` is only on with the scribe (a note has to have actions) and
`ADD_REPO` (the items need a repo to be created in); on without either is a
startup error that names what is missing. Off, the flag changes nothing at all.

## The calendar

With `CALENDAR_FILE` set, the bot reads a calendar snapshot that the Mac pushes
into a ConfigMap roughly every fifteen minutes, and holds it in memory.

*Why the Mac pushes.* The cluster has no route to a laptop, and giving it one
would mean an ingress path, a token and a certificate to pin. The Mac already
holds a kubeconfig that trusts the cluster's CA, so `mac/calendar/` reads
Calendar.app with EventKit, prints a small JSON snapshot, and writes it as one
ConfigMap (`zy-calendar` in this namespace) with `kubectl`. `deploy/` mounts it
at `/calendar` as **optional**, so a pod starts and stays up whether or not the
Mac has ever pushed — and a snapshot that already exists survives a restart,
the Mac sleeping, and a redeploy.

*What the snapshot holds.* Today and tomorrow: a two-day window from local
midnight, so a meeting that ends tomorrow still has its follow-up in the snapshot
of today. An opaque 16-hex-character id per event, start and end, `allDay`, the
title, how many attendees, each attendee's **domain** (never an address), and
whether it is `accepted`, `tentative`, `organizer` or `none`. Exchange sources
only by default; cancelled events and declined invites are left out. The window
starts at midnight, not at the push, so a meeting that ended an hour ago is still
in the snapshot — the follow-up after a meeting needs that.

*Fresh, stale, expired.* Fresh while `generatedAt` is under 45 minutes old. Past
that it is **stale** and still used: a sleeping Mac is a normal state, not an
error. Expired once now is past the snapshot's own window, and only then does the
bot behave as if there were no calendar. A duplicate push is a silent no-op; an
older snapshot is refused; a snapshot whose `generatedAt` is more than five
minutes in the future (a Mac clock running ahead) is refused too.

*Nothing is trusted.* The whole snapshot is rejected, never half of it, and the
reason names a field path, never a value: `events[3].end: not a timestamp`.
Titles and domains are never logged, and `node src/main.ts calendar` prints the
summary plus one line per event with no title at all. It exits 1 for an expired
snapshot — the window has closed, so the pipe is dead — and 0 when the snapshot
is only stale.

The Mac's half is documented in `mac/calendar/README.md`: build once (a `.app`
bundle, because a bare binary never gets the Calendar permission dialog), install
the launchd job, and it pushes from then on.

## Develop

Node 26 runs the TypeScript directly (`node --test`, type stripping: no build
step, `.ts` import extensions, no enums or namespaces).

```sh
npm test        # node:test, fakes only: no network, no timers
npm run typecheck
```

## Deploy

Container, deployed by NKP Project CD into the `zy-assistant` project namespace
on `zy-all-in-one` from `deploy/` (no Namespace and no `namespace:` in the YAML:
the Project owns that). The Secret `zy-assistant-secrets` is created outside
this repo and holds `GITHUB_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`,
`SLACK_USER_ID`. SQLite lives on the `zy-assistant-data` PVC at `/data`.

```sh
docker buildx build --platform linux/amd64 -t ghcr.io/rhapsody008/zy-assistant:0.1.0 --push .
```

Alternatively run it on the Mac under launchd. Put the four secrets in
`~/.config/zy-assistant/env`, then:

```sh
launchd/install.sh     # renders the plist into ~/Library/LaunchAgents, loads nothing
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.zy.assistant.plist"
launchctl bootout gui/$(id -u)/com.zy.assistant   # to stop it
```

`launchd/com.zy.assistant.plist.template` is the source, with `__REPO__` and
`__HOME__` filled in by the installer; it sets the PATH launchd does not have, so
`run.sh` finds node (it also falls back to `/opt/homebrew/bin/node`). `run.sh`
reads the env file and keeps the database in
`~/Library/Application Support/zy-assistant/state.db`. Logs go to
`~/Library/Logs/zy-assistant.log` (`KeepAlive` restarts the bot if it exits).

The Slack app manifest is `slack-app-manifest.yaml` (socket mode, so there is no
public URL; bot scopes `chat:write`, `im:write`, `im:history`).

## Release

A PR runs CI (`typecheck` + tests) on GitHub Actions: `.github/workflows/ci.yml`.

A release is a tag; Actions builds the image and pushes it to GHCR
(`.github/workflows/release.yml`):

```sh
git tag vX.Y.Z && git push origin vX.Y.Z
```

That publishes `ghcr.io/rhapsody008/zy-assistant:X.Y.Z` (linux/amd64, no `latest`).
Deploying is then a one-line bump of `newTag` in `deploy/kustomization.yaml` on
`main`: Project CD applies it. Rollback is reverting that commit.

Never deploy near the configured slot times (`BRIEF_TIME` / `EOD_TIME`): a tick
in flight is gone with the pod.

One-time setup: in the GHCR package settings, under "Manage Actions access", give
this repo Write.

## Health

With `HTTP_PORT` set (the manifest uses `8080`) `run` opens a `node:http` server
with one route. It records nothing else and needs no token.

```
GET /healthz
200 {"ok":true,"lastTickAt":"2026-11-25T01:00:00.000Z"}   last tick finished under 5 minutes ago
503 {"ok":false,"lastTickAt":null}                        no tick yet, or the last one is older
404                                                       any other path or method
```

`lastTickAt` is when the scheduler's last tick **finished**: the clock is read
again after the board fetch and the Slack sends, so a slow tick is not counted
as fresh from the moment it started. Every tick reports, whether it ran a slot
or not. The scheduler reports through an injected callback, so no state is
global and the tests drive it with a fake clock. Without `HTTP_PORT` no server
is started and the bot behaves exactly as before.

The deployment uses it as a liveness probe only: 30 s delay, 60 s period, 10
failed probes before a restart. A failing or refused probe counts, so the budget
is about 10.5 minutes at startup (30 s + 10 × 60 s) for the first tick to land,
and about 15 minutes once the ticks stop (5 minutes of freshness, then 10
probes). SIGTERM closes the server, then Slack, then the database.
