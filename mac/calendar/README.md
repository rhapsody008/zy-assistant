# The Mac side of `zya calendar`

`zya calendar` reads Calendar.app on the Mac it runs on. `src/calendar-export.ts`
opens `zy-calendar-export.app` here through LaunchServices, the app reads the
calendar with EventKit and prints one JSON snapshot of the window, and the CLI
parses and renders it. Nothing is pushed anywhere and nothing is scheduled: the
Mac needs no route to a cluster and no kubeconfig, and the command is run when
someone wants the day.

The export is `open -W -n --stdout <file> --stderr <file> -a <app> --args …`:
`open` is what gives the app a GUI session to own the permission, `-W` is what
makes the file complete when it is read, and the two files live in a private temp
directory of the export's own (`mkdtemp`, **mode 700**), created **mode 600** and
removed with the directory whichever way the export ends — success, a refused
snapshot or a failed launch. A cleanup that cannot happen is an error, not a
silence: a snapshot left behind is a meeting title on disk, and a title is the one
thing this side never leaves lying around.

The snapshot carries no bodies and no attendee addresses, only counts and domains,
because it is about to be rendered into a terminal, a note or a model's context,
and none of those needs to name a person. It does name the zone the window was cut
in (`"v": 2` plus `tz`, from the same `TimeZone.current` the window used), so a
reader in another zone can see that the day boundaries are not its own.

## Build once

```sh
./build.sh          # builds zy-calendar-export.app; ad-hoc signed, so build once
```

`./build.sh` must be run from a GUI session (Terminal is one) and the first run
raises the Calendar permission dialog. **It is built into a `.app` bundle for that
reason**: a bare binary started from a shell has no GUI session to own the TCC
request, and macOS answers `false` without ever showing the dialog — which looks
exactly like a denied permission and is not.

Rebuilding is not free: it changes the ad-hoc signature, which can cost a second
permission prompt (and a job that rebuilds for every run would ask for it every
run). Build once, keep the bundle, and rebuild only when `main.swift` changes —
then expect to confirm the grant once more.

## Usage

```sh
zya calendar                      # three days from today, as markdown
zya calendar --days 1             # today only
zya calendar --from -1 --days 2   # yesterday and today
zya calendar --format json        # the same events, with localDate/localStart/localEnd
ZY_CALENDAR_APP=/path/to/other.app zya calendar   # a bundle built somewhere else
```

`--days` is 1 to 14 (default 3) and `--from` is -14 to 0 days before today
(default 0). The window starts at local midnight and ends `--days` local midnights
later, so a meeting that ended an hour ago is still in today's window and
yesterday's meetings are still in yesterday's.

The window is cut in the Mac's zone and the lines are grouped in `ASSISTANT_TZ`
(Asia/Singapore by default), one `## Tue 1 Dec` per local day that has a meeting:

```
## Tue 1 Dec
- all day Offsite
- 09:00-10:00 Acme weekly sync (accepted, 6 attendees, acme.example)
```

`--format json` prints the same events, each with `localDate`, `localStart` and
`localEnd` added, so a script gets the day boundaries without re-doing them. A
window with no meetings prints nothing in markdown and `[]` as JSON; that is not a
failure.

**Exchange sources only**: the work calendar is the one to follow up on, and a
personal iCloud calendar has no business in a briefing. Cancelled events and
declined invitations are left out. The app's own `--all-sources` widens the set to
everything but birthdays and subscribed calendars; the CLI does not pass it, so
widening it is a deliberate edit to `src/calendar-export.ts`, not a flag.

## Check it

`zya calendar` goes through LaunchServices, so it is the way to check the pipe end
to end: it prints each meeting and exits 1 with the app's own reason when the grant
is missing. `zya calendar --format json` prints the snapshot as it was read, with
`localDate`, `localStart` and `localEnd` added, which is where a wrong day or a
wrong time is visible.

Do **not** run the binary from a shell to check it: a shell-launched process is
attributed to the shell, which has no Calendar grant, and you will see
`no calendar access (notDetermined)` on a Mac where everything works. To look at
the app's raw output instead, run it the way the CLI does — through `open`, into a
`mktemp` file, which is created mode 600, rather than a file made by hand:

```sh
snap=$(mktemp -t zy-calendar) && open -W -n --stdout "$snap" --stderr "$snap.err" \
  -a "$(pwd)/zy-calendar-export.app" --args --days 2
cat "$snap" "$snap.err"; rm -f "$snap" "$snap.err"
```

## When it fails

Every message below arrives after `calendar export failed: `, and the ones the app
raises carry its own `zy-calendar-export: ` prefix.

| Message | Cause |
| --- | --- |
| `zy-calendar-export: no calendar access (denied)` | The grant was never given: Privacy & Security → Calendars, or run `build.sh` once from Terminal |
| `zy-calendar-export: no calendars matched; nothing pushed` | No Exchange source, or the app needs `--all-sources`. The snapshot is refused rather than emptied |
| `open exited N` | The bundle is not there: build it, or `ZY_CALENDAR_APP` names a path that does not exist |
| `… over the 20 cap` / `… over the 200 cap` / `… over the 262144 cap` | A window the snapshot cannot hold whole: one event's domains, the event count, or the file's bytes. It is refused, never cut, so the counts stay true and nothing is printed. The caps are `DOMAINS_MAX`, `EVENTS_MAX` and `SNAPSHOT_MAX_BYTES` in `src/calendar.ts` |
| `zy-calendar-export: could not build the window` | The window's own arithmetic failed; that is a fault to report, not a setting to change |
| `zy-calendar-export: unknown argument; …` | The app takes `--days <n>`, `--from <n>`, `--all-sources` and `--exec <cmd…>`; anything else is a usage error, exit 2. `zya calendar` passes neither `--all-sources` nor `--exec` |

## Dependencies, all of them

A Mac with Calendar.app signed into the Exchange account and synced, and the
bundle built once from a GUI session with the Calendar grant given once. `zya
calendar` needs no `GITHUB_TOKEN` and no cluster: the zone comes from
`ASSISTANT_TZ` (or Asia/Singapore), and the rest is the calendar itself.
