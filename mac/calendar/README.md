# The Mac side of the calendar pipe

The cluster never reaches your Mac. This side pushes: `zy-calendar-export` reads
Calendar.app with EventKit, prints a small JSON snapshot for today and tomorrow
(no bodies, no attendee addresses, only counts and domains), and `push.sh` writes
it as one ConfigMap through the kubeconfig you already have. The bot mounts that
ConfigMap as a file and reads it on its own tick.

The snapshot also names the zone the window was cut in (`"v": 2` plus `tz`, from
the same `TimeZone.current` the window used). That is what lets the bot say so
plainly when your Mac's zone and its own disagree, instead of filing meetings
under the wrong day: while the two differ, the bot stops using the snapshot's
days and asks nothing about them.

It pushes **twice a day**, at 07:30 and 18:30 local time, plus once at login.
A calendar does not change much between two runs, and either snapshot starts at
today's midnight, so both cover today and tomorrow: 07:30 is there for the 09:00
briefing, 18:30 keeps tomorrow's answer right in the evening. A sleeping Mac runs
the missed slot when it wakes. To push on demand, `launchctl kickstart -k` below.

## Once

```sh
./build.sh          # builds zy-calendar-export.app; ad-hoc signed, so build once
./install.sh        # asks for the kubeconfig path, writes the launchd job
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.zy.assistant.calendar.plist
```

The kubeconfig it asks for should be the scoped one, not your admin one: the push
only needs to patch the ConfigMap `zy-calendar` (ServiceAccount `zy-calendar-push`,
from `deploy/rbac.yaml` in the repo). Build it from a bound token, with the server
and CA copied out of the admin kubeconfig so the token is the only credential in
the file:

```sh
SRC=~/zyworkspace/zy-ops/kubeconfigs/zy-all-in-one.conf
DST=~/.config/zy-assistant/zy-calendar-push.conf
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}' --kubeconfig "$SRC")
CA=$(kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' --kubeconfig "$SRC")
TOKEN=$(kubectl create token zy-calendar-push -n zy-assistant --duration=8760h --kubeconfig "$SRC")
kubectl config set-cluster zy-all-in-one --server="$SERVER" --certificate-authority-data="$CA" --kubeconfig "$DST"
kubectl config set-credentials zy-calendar-push --token="$TOKEN" --kubeconfig "$DST"
kubectl config set-context zy-calendar-push --cluster=zy-all-in-one --user=zy-calendar-push --namespace=zy-assistant --kubeconfig "$DST"
kubectl config use-context zy-calendar-push --kubeconfig "$DST"
chmod 600 "$DST"
```

Prove it is only what it claims: `kubectl get secrets -n zy-assistant --kubeconfig "$DST"`
must be refused, and `launchctl kickstart -k` must still print a `pushed:` line. The
token lasts a year, so put the rotation in the calendar before it lapses; a lapsed
token fails the push with a 401 and the ConfigMap stays at its last snapshot.
```

`./build.sh` must be run from a GUI session (Terminal is one) and the first run
raises the Calendar permission dialog. **It is built into a `.app` bundle for that
reason**: a bare binary started from a shell has no GUI session to own the TCC
request, and macOS answers `false` without ever showing the dialog — which looks
exactly like a denied permission and is not. Rebuilding changes the ad-hoc
signature, which can cost a second prompt, so build once and keep the bundle.

The launchd job pushes with the cluster-admin kubeconfig `install.sh` asks for,
which is more than one `kubectl patch` on one ConfigMap needs: a ServiceAccount
scoped to that patch is the known follow-up.

## Check it

```sh
tail -f ~/Library/Logs/zy-assistant-calendar.log        # 'pushed: N bytes' at each slot
launchctl kickstart -k gui/$(id -u)/com.zy.assistant.calendar   # run it now
kubectl exec deploy/zy-assistant -n zy-assistant -- node src/main.ts calendar
```

Do **not** run the binary from a shell to check it: a shell-launched process is
attributed to the shell, which has no Calendar grant, and you will see
`no calendar access (notDetermined)` on a Mac where everything works. Either let
launchd start it (`kickstart` above) or go through LaunchServices:

```sh
open -a "$(pwd)/zy-calendar-export.app" --args --days 2 --exec /usr/bin/tee /tmp/snap.json
```

The middle command is the whole pipe end to end: it prints the snapshot the bot
holds, its age and freshness, and one line per event with no titles. It exits
non-zero when the snapshot is **expired** (the pipe is dead), and zero when it is
merely stale (the Mac is asleep, which is normal).

## When it fails

| Log line | Cause |
| --- | --- |
| `no calendar access (denied)` | The grant was never given: Privacy & Security → Calendars, or run `build.sh` once from Terminal |
| `no calendars matched; nothing pushed` | No Exchange source (or `--all-sources` needed); the snapshot is left alone rather than emptied |
| `could not start the pusher` / `the pusher exited N` | `push.sh` missing or the kubeconfig is unreadable: `install.sh` again |
| `… over the 20 cap` / `… over the 200 cap` / `… over the 262144 cap` | A day the snapshot cannot hold whole. It is refused, not cut, so the pod's own counts stay true; the previous snapshot stays in place |
| `pushed:` stops appearing | launchd job unloaded, or the Mac asleep (a sleeping Mac is expected: the cluster keeps the last snapshot until its window ends) |

## Dependencies, all of them

Mac awake and online, with a route to the cluster's LAN (that is how the API is
reached), Calendar.app signed into the Exchange account and synced, and a
kubeconfig that still authenticates. Any of those missing means a stale snapshot,
never a wrong one.
