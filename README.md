# zy-assistant

A Slack DM bot that reminds ZY what the GitHub Project board says to do today.

It reads a GitHub Project v2 board, applies the rules in `src/rules.ts`, and DMs
the result at two slots on weekdays (Asia/Singapore):

- **M**, `BRIEF_TIME` (09:00): one morning briefing, then a ping per In-progress
  item that needs action (Target date within 3 days, overdue, or Next touch due).
  A Workshop or a POC is pinged two weeks and one week out too, and a Waiting item
  nobody touched for a few days is chased. Friday adds a Pipeline and a Learning
  section to the briefing.
- **E**, `EOD_TIME` (17:30): a ping for every item whose Target date is today, and
  a re-ping for every morning ping that was never acked.

A slot runs at most once. If Slack fails half way through, the next minute tick
retries and sends only what never went out (the morning briefing included), and
after three failures it closes the slot and DMs the error.

A ping is acked by pressing a button, replying in its Slack thread, updating the
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

It also takes dictations: DM `note: …` and the scribe turns it into an entry of
the notes repo and replies with the link (see **The scribe**).

## Using the bot

DM the bot `help` (or `?`, or `manual`) and it answers with the manual below;
`help <topic>` opens one topic, and an unknown topic answers the overview with
`No topic <x>.` on top. Any other DM that is no command gets a one-line hint.
The text is rendered from `src/manual.ts` with the live policy and slot times
(`WAITING_CHASE_DAYS`, `STAGE_STALE_DAYS`, the lead times, the WIP limit), so the
topic pages say what this deployment does. The `note` topic is left out when the
scribe is off, and the notes-repo ack below when `NOTES_REPO` is unset. With the
defaults, `help` sends exactly this:

```
*Briefing*
• Two DMs a day on weekdays (Asia/Singapore): the morning briefing at `09:00` and the end-of-day sweep at `17:30`.
• The morning one: Today, Coming up, Stale dates, a ⚠ line per unanswered re-ping, and the In-progress count.
• Friday adds Pipeline and Learning. `briefing` in a DM previews the morning plan.

*Pings*
• A ping is one DM about one item: its link, why it is due, and its buttons.
• A Target date pings from T-3 down to T-0, then daily while it is overdue (14 days).
• Also: Workshop at T-14 and T-7, POC at T-14 and T-7; a Next touch that is due; a Waiting item nobody moved for 5 days.
• What is still unanswered at 17:30 is re-pinged, and shows as ⚠ the next morning.

*Buttons*
• Every ping has buttons under it. Only your clicks count, and a click is the approval: I write to the board at once.
• *👍 On it* changes nothing on the board; it only marks the ping handled. *✅ Done* sets Status to Done.
• *Tomorrow* and *+7 days* move Next touch. *Move date* sets Target date and comments why.
• A plain reply in the ping's thread acks it too.

*Notes*
• `note: <text>` in a DM, or in a ping's thread, and I turn it into a note.
• It lands at the top of the log in `<folder>/README.md` of the notes repo, and I reply with the commit link.
• No folder fits, or the model fails? I ask where it goes. Nothing dictated is ever lost.

*Updates*
• An ack is what stops a re-ping: a button, a reply, or progress on the board.
• The board item changing after the ping acks it, so editing it on GitHub is enough.
• A commit under `Accounts/<Account>/` in the notes repo does the same.

Reply `help <topic>` for details: `briefing`, `pings`, `buttons`, `note`, `updates`.
```

Every successful action is one log line with ids only, never a note's text or
title: `scribe <ts>: committed <folder> in <ms> ms (<n> actions) <url>`,
`scribe <ts>: asked for a folder`, `scribe <ts>: committed raw text to <folder>`,
`button <action> on <item> by <user>`, `move <item>: <old> -> <new>`,
`reply ack <item>` and `help <topic>`.

## Env

| Variable | Needed by | Default |
| --- | --- | --- |
| `GITHUB_TOKEN` | every mode | – (fine-grained PAT: read the project, write the items) |
| `SLACK_BOT_TOKEN` | `run`, optional `check` | – |
| `SLACK_APP_TOKEN` | `run`, optional `check` | – |
| `SLACK_USER_ID` | `run`, optional `check` | – (the only person the bot DMs and obeys) |
| `PROJECT_OWNER` | | `rhapsody008` |
| `PROJECT_NUMBER` | | `1` |
| `BRIEF_TIME` | | `09:00` |
| `EOD_TIME` | | `17:30` |
| `DB_PATH` | | `./data/state.db` |
| `ASSISTANT_TZ` | | `Asia/Singapore` |
| `NOTES_REPO` | | – (owner/repo: a commit under `Accounts/<Account>` acks that Account's items and the scribe writes here; unset turns both off) |
| `WAITING_CHASE_DAYS` | | `5` (a Waiting item with no update for longer is chased) |
| `STAGE_STALE_DAYS` | | `21` (a pipeline item with no update for longer is nagged on Friday) |
| `LLM_BASE_URL` | `scribe`, `check` | – (an OpenAI-compatible gateway, e.g. `https://<host>/enterpriseai/gateway/v1`) |
| `LLM_API_KEY` | `scribe`, `check` | – |
| `LLM_MODEL` | `scribe`, `check` | – (e.g. `zy-pi-uep`) |
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
node src/main.ts run                                     # Slack + scheduler, every 60 s
```

`dry-run` reads the live board with an empty history: it prints, it never sends,
never writes to the board and never opens the database.

`scribe` reads the dictation from stdin and runs the same pipeline a DM does,
without Slack and without the database: `listFolders`, the model, and the render
(`--dry-run`) or the commit. A dictation no existing folder fits prints the
suggested `Accounts/<name>` and writes nothing.

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
   note's actions with "board proposals: coming in step 2".

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
actions are also stored (in the dictation's `note_json`) and listed in the reply:
they are what step 2 will turn into board proposals. Nothing proposes anything
to the board yet.

The Slack handler returns before the work starts and every error becomes a
thread reply, so Slack's three-second budget is never the scribe's problem. The
deployment's secret does not carry the LLM variables yet: the pod runs with the
scribe off, by design.

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
