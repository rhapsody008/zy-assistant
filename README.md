# zya

`zya` is a local CLI over ZY's GitHub Project board, the notes repo and the Mac's
calendar. It runs where ZY is, when ZY — or an agent acting for ZY — runs it: no
chat bot, no database, no scheduler, no server. Every read prints its result; two
commands write, and a write is a decision ZY makes before the command is typed
(see **Writes**).

- **reads**: `zya brief`, `zya yesterday`, `zya calendar`. They fetch, they print,
  they change nothing.
- **writes**: `zya update` (one board item: its fields and a comment on its issue)
  and `zya note` (one entry into the notes repo). Given `--dry-run` they write
  nothing either, and that is how every example below is written.

Node 26 runs the TypeScript directly (type stripping: `.ts` import extensions, no
enums), so there is nothing to build.

## Install

```sh
npm ci
ln -sf "$PWD/bin/zya" ~/bin/zya      # ~/bin has to be on PATH
```

`bin/zya` is a shim: it resolves its own path and hands the arguments to
`src/cli.ts`, so the command works from any directory and through the symlink.

## The token

`GITHUB_TOKEN` is GitHub's, and only the commands that talk to GitHub need it: it
is loaded after the command line is read, so `zya help` and `zya calendar` work on
a machine with no token at all. A fine-grained PAT covering this much is enough:

- `zya brief` and `zya yesterday` read the project and its issues — **Projects:
  read, Issues: read**;
- `zya yesterday` also reads the notes repo's commits, and `zya note` reads and
  writes its READMEs — **Contents: read**, and **read and write** for `zya note`,
  on `NOTES_REPO`;
- `zya update` writes the item's fields and may leave a comment on its issue —
  **Projects: read and write, Issues: read and write**;
- `zya note` touches nothing but `NOTES_REPO`: no project access, and no Issues
  permission, because it never reads or comments on an issue.

The token comes from the shell, and when the shell has none, from the
`GITHUB_TOKEN=` line of `~/.config/zy-assistant/env` (quotes stripped; the rest of
that file is not read). It is never printed and never appears in an error: the
message names the variable instead.

| Variable | Default | What it sets |
| --- | --- | --- |
| `GITHUB_TOKEN` | – | the one secret; needed by `brief`, `yesterday`, `update` and `note` |
| `PROJECT_OWNER` | `rhapsody008` | the owner of the Project v2 board |
| `PROJECT_NUMBER` | `1` | the board's number |
| `NOTES_REPO` | `rhapsody008/notes` | owner/repo: `zya yesterday` reads its commits, `zya note` writes its READMEs |
| `ASSISTANT_TZ` | `Asia/Singapore` | the reporting zone: every date, day and window a command prints is read in it |
| `ZY_CALENDAR_APP` | `$HOME/zyworkspace/gitrepo/zy-assistant/mac/calendar/zy-calendar-export.app` | the bundle `zya calendar` opens |

An empty variable is an unset one. `zya note` reads only the token and
`NOTES_REPO`: a broken `PROJECT_NUMBER` is not a note's failure.

## Commands

Every command prints to stdout and exits 0. There are two exit-1 paths, and they
print on different streams:

- **a throw** — a board it cannot read, a refused date, a note that is not valid —
  prints one line, its message, on stderr, and nothing on stdout;
- **`zya update` failing while it applies its plan** has already written part of
  it: it prints that result on stdout and exits 1. See **zya update** — read it
  before running anything again.

A command line zya does not know is the usage text on stderr, exit 2.
`--format json` prints the same result as JSON, with the shape the code works in —
that is what a script reads.

### `zya help`

```sh
zya help
```

Prints the usage text — every subcommand with its flags, and what each one does —
on stdout, exit 0. The same text is what a bad command line prints on stderr.

### `zya brief`

```sh
zya brief                                    # today, in ASSISTANT_TZ
zya brief --date 2026-11-27                  # a Friday, sections and all
zya brief --format json                      # date, rows, head, tail, text
zya brief --links plain                      # for a terminal
zya brief --links raw                        # the briefing's own markup, untouched
```

The morning briefing of the board, as the rules in `src/rules.ts` read it: a row
per item that needs ZY today (late, due or due a touch, a chase, a head-up), the
soonest first; then *Coming up*, *Stale dates*, the Friday *Pipeline* and
*Learning* sections, and the count in progress. `--date` is any `YYYY-MM-DD`; the
date it prints is the date it was asked about.

`--links` is how the two marks the briefing is built with — `<url|ref>` for a link
and `*word*` for emphasis — are spelled: `md` (default) writes a markdown link and
`**double**` emphasis, `plain` puts the url behind its text in parentheses and
drops the asterisks, and `raw` keeps the markup exactly as the rules wrote it.

### `zya calendar`

```sh
zya calendar                      # three days from today, as markdown
zya calendar --days 1             # today only
zya calendar --from -1 --days 2   # yesterday and today
zya calendar --format json        # the same events, with localDate/localStart/localEnd
```

Reads Calendar.app on this Mac: `--days` is 1 to 14 (default 3) and `--from` is
-14 to 0 days before today (default 0), and the window starts at a midnight, so a
meeting that ended an hour ago is still in today's window. Exchange sources only:
a personal calendar has no business in a briefing, and cancelled events and
declined invitations are left out. Each meeting is a line with its time, its
title, whether ZY answered, how many are coming and the domains it is with —
never an address and never a body:

```
## Tue 1 Dec
- all day Offsite
- 09:00-10:00 Acme weekly sync (accepted, 6 attendees, acme.example)
```

**Two zones, and only one of them is `ASSISTANT_TZ`.** The export's window is cut
at midnights in the **Mac's own zone** (`TimeZone.current` in the exporter): which
meetings `--days 1` returns is the Mac's day, wherever the Mac is. `ASSISTANT_TZ`
is the **reporting** zone: it decides which day each returned meeting is printed
under, and it is what `zya brief` and `zya yesterday` measure their dates and
windows in. When the two disagree, a meeting is printed under its `ASSISTANT_TZ`
day, which need not be the day the Mac returned it for.

**It needs the bundle, built once.** `zya calendar` opens a
`zy-calendar-export.app` through LaunchServices, and the app reads the calendar
with EventKit. The bundle exists for one reason: macOS's Calendar permission (TCC)
is granted to a GUI app, and a bare binary started from a shell gets
`notDetermined` and no dialog at all. So:

```sh
cd mac/calendar && ./build.sh     # from Terminal, which is a GUI session
```

The first run asks for the Calendar permission: give it once. A rebuild changes
the ad-hoc signature and can cost a second prompt, so rebuild only when
`main.swift` changed — and expect to confirm the grant again. Every failure
message and its cause are in `mac/calendar/README.md`.

**Which bundle.** The default is an absolute path, not a path relative to the
checkout: `$HOME/zyworkspace/gitrepo/zy-assistant/mac/calendar/zy-calendar-export.app`.
A clone somewhere else builds its own bundle and names it, or `zya calendar`
keeps opening the one at that fixed path:

```sh
ZY_CALENDAR_APP="$PWD/mac/calendar/zy-calendar-export.app" zya calendar
```

### `zya yesterday`

```sh
zya yesterday                     # since the previous workday
zya yesterday --date 2026-11-30   # a Monday: the window covers the weekend
zya yesterday --format json
```

One report of what happened in the window between the previous workday's midnight
and today's: the meetings, the board items that moved, the comments on their
issues, and the notes-repo commits. A Monday's window reaches back to Friday, so
Friday, Saturday and Sunday are all inside it. It is a window, not an audit of it:
the notes repo's commits are listed one page (up to 100) and opened up to 30 of
them, and each repo is asked for one page of 100 comments, so a busy weekend can
hold activity inside those dates and outside the report. `truncated` in the JSON
says so for the commits; the comment read has no such flag. A calendar the Mac
refuses is a line in the report, because the rest of the window happened all the
same; a notes or comments read that fails stops the report, because half of one
would lie.

### `zya update`

```sh
zya update --ref demo#52 --status Done --dry-run
zya update --ref demo#52 --target 2026-12-02 --comment "moving to December" --dry-run
zya update --ref demo#52 --next-touch 2026-11-30 --waiting-on Dana --dry-run
zya update --ref demo#52 --target none --next-action "" --dry-run
```

One board item: the fields to change and, optionally, a comment on its issue. The
item is its project item id, or a ref (`demo#52`) the board has exactly one of. A
date is cleared with `none` and a text with an empty string; at least one field
change or a comment is required, and a run with neither is a usage error. The
fields are the board's own names: `Status` (an option the board has), `Target
date`, `Next touch`, `Next action`, `Waiting on`.

Everything the writes need — the field's id, the option's id, the issue's id — is
resolved against the board the plan was made from, before the first write, so a
bad date or an unknown option fails with nothing written. `--dry-run` prints that
plan and writes nothing. The same line without `--dry-run` is the write; see
**Writes** before typing it.

Both print JSON on stdout. A dry run prints the plan, `{ "item", "ops" }`. A
real run prints `applied`, the writes GitHub confirmed, and — when one was being
written as the answer was lost — `failed`, in which case it exits 1. That write may have landed after all, and the
ops after it were never attempted, so **read `applied` and `failed` before running
anything again**: a second run repeats the writes that already went through.

### `zya note`

```sh
zya note --dry-run < note.json    # the folder, the path and the entry; nothing written
```

One note, as JSON on stdin, written into the notes repo as one entry under its
folder's `## Log`, newest first. The same line without `--dry-run` is the write,
and prints the same result plus the commit's url; see **Writes** before typing it.

```json
{
  "folder": "Accounts/Acme",
  "newFolderName": null,
  "date": "2026-11-25",
  "type": "Workshop",
  "topic": "Acme VPC sizing",
  "attendees": ["ZY", "Ana"],
  "summary": "We sized the VPC. Ten nodes is enough.",
  "decisions": ["Ten nodes"],
  "actions": [{ "owner": "ZY", "text": "send the sizing sheet", "due": "2026-11-28" }]
}
```

`folder` is one the repo lists right now, and `newFolderName` is the other way
round: a bare name, no `Accounts/` and no slash, which becomes the new folder
`Accounts/<name>`. A note that creates one says so like this:

```json
{ "folder": null, "newFolderName": "Acme", "date": "2026-11-25", "type": "Workshop", "topic": "Acme VPC sizing", "attendees": [], "summary": "…", "decisions": [], "actions": [] }
```

and writes `Accounts/Acme/README.md`; `"newFolderName": "Accounts/Acme"` is
refused, because a folder name is not a path. `type` is one of `POC`, `Workshop`,
`Follow-up`, `Demo-Slides`, `Partner`, `Experiment`, `Learning`, `Admin`,
`Meeting`. Every field and the folder are checked before anything is written,
so an invalid note writes nothing at all. The run prints the folder, the README's path, the entry and
the commit's url (null in a dry run); the entry is committed as
`notes(<folder>): <date> <topic> [zya]`, and a write that lost its sha to another
writer is read again and tried again, up to three attempts in total.

Format v0 of an entry:

```markdown
## 2026-11-25 · Workshop · Acme VPC sizing

**Attendees:** ZY, Ana
**Summary:** Two to five sentences.
**Decisions:**
- Ten nodes

### Actions
- [ ] ZY: send the sizing sheet (due 2026-11-28)

_Written via zya._
```

`Attendees`, `Decisions` and `### Actions` are left out when they are empty. A
folder with no README gets one: a status table, Context, Contacts, and the Log the
entry goes under.

## Writes

`zya update` and `zya note` are the only two commands that change anything. The
command itself asks no questions and shows no preview: run without `--dry-run` it
writes, straight away. So the gate is around it, not a prompt inside the tool —
and every example above is a dry run for that reason.

- **`--dry-run` always passes.** It prints exactly what would be written — the
  update's plan, or the note's folder, path and entry — and writes nothing. It is
  safe on any machine, and it is what every write starts with.
- **In a pi session, a write prompts.** pi's git gate
  (`~/.pi/agent/extensions/git-gate.ts`) asks ZY before any `zya update` or
  `zya note` that lacks `--dry-run`, so pi runs the dry run first, shows ZY what
  it printed, and then runs the same command without `--dry-run`. A declined
  prompt ends it there, and nothing was written.
- **In a shell, the CLI trusts the typist.** There is no confirmation prompt and no
  second look: whoever types `zya update` or `zya note` without `--dry-run` has
  already decided to write. That is why the examples here carry `--dry-run`.
- **One run, one change.** Nothing is queued and nothing is left to happen later.
  The one retry in the tool is the note's conflict retry inside a single run — a
  write that lost its sha is read again, up to three attempts — and it is not a
  licence to re-run a command that failed: that decision is ZY's, taken after
  looking at what the failed run printed (see **zya update**).
- **The reads are never gated**, because they change nothing.

## Delivery (parked)

Delivery is parked: while this is a CLI, nothing is mailed, messaged or
scheduled, and no queue holds a briefing until someone reads it. The shape it comes
back in is a pipe, because the briefing is already text:
`zya brief --links plain` writes it for a terminal — no markup to unescape, no
asterisks — and one sender takes it from stdin and posts it, `zya brief --links
plain | <sender>`. The sender's webhook URL is a secret: it is read from the macOS
Keychain at the moment of sending (`security find-generic-password -s <item> -w`),
never from a file in this repo. Nothing else is parked with it: the reads and the
writes above do not depend on delivery.

## Develop

```sh
npm test        # node:test, fakes only: no network, no real clock, no calendar
npm run typecheck
```
