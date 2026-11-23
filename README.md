# zy-assistant

A Slack DM bot that reminds ZY what the GitHub Project board says to do today.

It reads a GitHub Project v2 board, applies the rules in `src/rules.ts`, and DMs
the result at two slots on weekdays (Asia/Singapore):

- **M**, `BRIEF_TIME` (09:00): one morning briefing, then a ping per In-progress
  item that needs action (Target date within 3 days, overdue, or Next touch due).
- **E**, `EOD_TIME` (17:30): a ping for every item whose Target date is today, and
  a re-ping for every morning ping that was never acked.

A slot runs at most once. If Slack fails half way through, the next minute tick
retries and sends only what never went out (the morning briefing included), and
after three failures it closes the slot and DMs the error.

A ping is acked by pressing a button, replying in its Slack thread, or updating
the item on the board. Buttons write to the board (ZY's click is the approval):
👍 On it (ack), ✅ Done (Status = Done), Tomorrow / +7 days (Next touch, rolled
off the weekend).

The board is mapped by field **name**: `Status` (single select), `Target date`,
`Next touch` (dates), `Next action`, `Waiting on` (text). Closed or merged
content counts as `Done`.

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

No token is ever logged or written to the database.

## Modes

```sh
node src/main.ts check                                   # board summary + Slack hello DM
node src/main.ts dry-run --date 2026-11-25               # print M and E for that day
node src/main.ts dry-run --date 2026-11-25 --slot M      # just the morning
node src/main.ts dry-run --week 2026-11-23               # Mon-Fri, M and E (a Monday)
node src/main.ts run                                     # Slack + scheduler, every 60 s
```

`dry-run` reads the live board with an empty history: it prints, it never sends,
never writes to the board and never opens the database.

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
