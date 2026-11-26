// zy-calendar-export: reads the Mac's calendar with EventKit and prints a small
// JSON snapshot of a window, which `zya calendar` (src/calendar-export.ts) reads
// and renders.
//
// Two things about it are deliberate and were learned the hard way in the spike
// that lives in the ops workspace:
//
//   * It is built into a .app bundle, not run as a bare binary. A process without
//     a GUI session to own it gets "false" from the EventKit request and never
//     sees a dialog, so the permission would silently never be granted.
//   * Its output carries no bodies and no attendee addresses, only counts and
//     domains, because the snapshot ends up in a ConfigMap in a dev cluster.
//
// It never prints a title: the assistant's rule is that logs carry ids, and this
// binary's stdout may well be the log. Failures go to stderr as one line.
import CryptoKit
import EventKit
import Foundation

// ---- Arguments -------------------------------------------------------------

struct Options {
  var days = 2
  var from = 0
  var allSources = false
  var exec: [String] = []
}

func fail(_ code: Int32, _ message: String) -> Never {
  FileHandle.standardError.write(("zy-calendar-export: " + message + "\n").data(using: .utf8) ?? Data())
  exit(code)
}

func parseArguments(_ arguments: [String]) -> Options {
  var options = Options()
  var index = 0
  while index < arguments.count {
    switch arguments[index] {
    case "--days":
      guard index + 1 < arguments.count, let days = Int(arguments[index + 1]), days >= 0, days <= 31 else {
        fail(2, "--days needs a whole number of days, 0 to 31")
      }
      options.days = days
      index += 2
    case "--from":
      guard index + 1 < arguments.count, let from = Int(arguments[index + 1]), from >= -14, from <= 0 else {
        fail(2, "--from needs a whole number of days, -14 to 0")
      }
      options.from = from
      index += 2
    case "--all-sources":
      options.allSources = true
      index += 1
    case "--exec":
      // Everything after --exec is the command, so a shell is not needed and a
      // title with spaces or quotes cannot be re-split.
      options.exec = Array(arguments[(index + 1)...])
      index = arguments.count
    default:
      fail(2, "unknown argument; --days <n>, --from <n>, --all-sources, --exec <cmd...>")
    }
  }
  return options
}

// ---- Access ----------------------------------------------------------------

func statusName(_ status: EKAuthorizationStatus) -> String {
  switch status {
  case .notDetermined: return "notDetermined"
  case .restricted: return "restricted"
  case .denied: return "denied"
  case .authorized: return "authorized"
  case .fullAccess: return "fullAccess"
  case .writeOnly: return "writeOnly"
  @unknown default: return "unknown"
  }
}

let store = EKEventStore()
let options = parseArguments(Array(CommandLine.arguments.dropFirst()))

// Ask only when nobody has been asked yet: a scheduled run on a Mac where the
// question cannot be shown must log once and stop, never raise a dialog storm.
if EKEventStore.authorizationStatus(for: .event) == .notDetermined {
  let semaphore = DispatchSemaphore(value: 0)
  if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { _, _ in semaphore.signal() }
  } else {
    store.requestAccess(to: .event) { _, _ in semaphore.signal() }
  }
  _ = semaphore.wait(timeout: .now() + 300)
}

let authorised: Bool
if #available(macOS 14.0, *) {
  authorised = EKEventStore.authorizationStatus(for: .event) == .fullAccess
} else {
  authorised = EKEventStore.authorizationStatus(for: .event) == .authorized
}
if !authorised {
  fail(3, "no calendar access (" + statusName(EKEventStore.authorizationStatus(for: .event)) + ")")
}

store.refreshSourcesIfNecessary()

// ---- Which calendars -------------------------------------------------------

// Exchange by default: the work calendar is the one the assistant follows up on,
// and a personal iCloud calendar has no business in a cluster ConfigMap.
func wanted(_ source: EKSource) -> Bool {
  if !options.allSources { return source.sourceType == .exchange }
  return source.sourceType != .birthdays && source.sourceType != .subscribed
}

let calendars = store.sources.filter(wanted).flatMap { $0.calendars(for: .event) }
if calendars.isEmpty {
  // Never let "no calendars" overwrite a good snapshot: an account that fails to
  // load for a minute would otherwise erase the assistant's whole calendar.
  fail(4, "no calendars matched; nothing pushed")
}

// ---- The window ------------------------------------------------------------

// From the start of today, not from now: a meeting that ended at 10:00 has to
// still be in the 10:05 snapshot, or the follow-up after it can never fire.
// --from moves that start back by whole days, so a reader can ask for yesterday
// without a second binary; the start is a midnight either way.
var calendar = Calendar(identifier: .gregorian)
calendar.timeZone = TimeZone.current
let now = Date()
let startOfToday = calendar.startOfDay(for: now)
guard let windowStart = calendar.date(byAdding: .day, value: options.from, to: startOfToday) else {
  fail(5, "could not build the window")
}
guard let windowEnd = calendar.date(byAdding: .day, value: options.days, to: windowStart) else {
  fail(5, "could not build the window")
}

let events = store.events(matching: store.predicateForEvents(withStart: windowStart, end: windowEnd, calendars: calendars))

// ---- One event -------------------------------------------------------------

let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime]

/// Opaque and stable: the same occurrence of the same event gets the same id, so
/// the assistant can dedupe a meeting across pushes without knowing its title.
///
/// The external identifier is the seed because Exchange keeps it across Macs and
/// accounts; an event without one falls back to EventKit's own, and then to the
/// calendar item's, which is the last thing that tells two unidentified
/// occurrences apart. The start is always in the seed: one recurring meeting
/// repeats its identifiers on every occurrence.
func identifier(_ event: EKEvent) -> String {
  let seed = (event.calendarItemExternalIdentifier ?? event.eventIdentifier ?? event.calendarItemIdentifier)
    + "|" + iso.string(from: event.startDate)
  let digest = SHA256.hash(data: Data(seed.utf8))
  return digest.map { String(format: "%02x", $0) }.joined().prefix(16).description
}

/// attendee domains only: an address names a person, a domain names a company,
/// and neither belongs in the snapshot as anything but a domain.
func domainOf(_ participant: EKParticipant) -> String? {
  var address = participant.url.absoluteString
  if let range = address.range(of: "mailto:", options: .caseInsensitive) {
    address = String(address[range.upperBound...])
  }
  // Exchange hands out X500 addresses (…/O=…/CN=…) for people outside the org.
  // They carry no domain and no use here.
  guard let at = address.lastIndex(of: "@") else { return nil }
  let domain = address[address.index(after: at)...].lowercased()
  // A domain the pod would refuse is dropped here rather than pushed: one bad
  // address must not cost a whole day's snapshot, while cutting a list would make
  // the snapshot's own counts a lie. The shape and the length are calendar.ts's.
  let shape = "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$"
  guard domain.count <= 100, domain.range(of: shape, options: .regularExpression) != nil else { return nil }
  return domain
}

func isDeclined(_ event: EKEvent) -> Bool {
  guard let attendees = event.attendees else { return false }
  return attendees.contains { $0.isCurrentUser && $0.participantStatus == .declined }
}

func statusOf(_ event: EKEvent) -> String {
  guard let attendees = event.attendees else { return event.organizer?.isCurrentUser == true ? "organizer" : "none" }
  if event.organizer?.isCurrentUser == true { return "organizer" }
  guard let me = attendees.first(where: { $0.isCurrentUser }) else { return "none" }
  // No declined case: such an event was dropped before it got here, and the pod's
  // four statuses have no room for one.
  switch me.participantStatus {
  case .accepted: return "accepted"
  case .tentative: return "tentative"
  default: return "none"
  }
}

/// A title is clipped rather than dropped: it is context the assistant quotes
/// back, and a 300-character subject line is still a subject line.
func clipped(_ title: String) -> String {
  title.count <= 200 ? title : String(title.prefix(200))
}

var records: [[String: Any]] = []
var seen = Set<String>()
for event in events {
  if event.status == .canceled { continue }
  if isDeclined(event) { continue }
  let id = identifier(event)
  // A shared or delegate calendar can hold one occurrence too, with the same
  // external identifier and start, so both derive the same id. The pod refuses a
  // duplicate id and with it the whole snapshot, and the first of the two is as
  // true as the second: keep it.
  if !seen.insert(id).inserted { continue }
  let domains = Set((event.attendees ?? []).compactMap(domainOf)).sorted()
  // Refused, never cut: the pod counts what it is given, and a list cut here
  // would make that count a lie. The message names the cap, never a domain.
  if domains.count > 20 {
    fail(5, "one event has \(domains.count) domains, over the 20 cap; nothing pushed")
  }
  records.append([
    "id": id,
    "start": iso.string(from: event.startDate),
    "end": iso.string(from: event.endDate),
    "allDay": event.isAllDay,
    "title": clipped(event.title ?? ""),
    "domains": Array(domains),
    "attendees": event.attendees?.count ?? 0,
    "status": statusOf(event),
  ])
}
records.sort { ($0["start"] as? String ?? "") < ($1["start"] as? String ?? "") }
// The same refusal as the domains, for the same reason.
if records.count > 200 {
  fail(5, "\(records.count) events, over the 200 cap; nothing pushed")
}

// ---- The snapshot ----------------------------------------------------------

let snapshot: [String: Any] = [
  "v": 2,
  // The zone the window and the day boundaries were cut in, from the same object
  // that cut them: the bot keeps days in its own zone, so it needs to know when
  // the two disagree instead of guessing that the laptop never travels.
  "tz": calendar.timeZone.identifier,
  "generatedAt": iso.string(from: now),
  "window": ["start": iso.string(from: windowStart), "end": iso.string(from: windowEnd)],
  "events": records,
]

guard let payload = try? JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys]) else {
  fail(5, "could not serialise the snapshot")
}

// The pod refuses a snapshot over this before it parses one, so pushing one it
// will refuse would only make the bot keep the previous one while the log looks
// healthy. The cap is SNAPSHOT_MAX_BYTES in src/calendar.ts.
let maxBytes = 256 * 1024
if payload.count > maxBytes {
  fail(5, "snapshot is \(payload.count) bytes, over the \(maxBytes) cap; nothing pushed")
}

// ---- Where it goes ---------------------------------------------------------

if options.exec.isEmpty {
  FileHandle.standardOutput.write(payload)
  FileHandle.standardOutput.write("\n".data(using: .utf8) ?? Data())
  exit(0)
}

let process = Process()
// The command itself, not /usr/bin/env: env reads an argument containing "=" as a
// variable assignment, so a pusher path with one in it would never be started.
process.executableURL = URL(fileURLWithPath: options.exec[0])
process.arguments = Array(options.exec.dropFirst())
let input = Pipe()
process.standardInput = input
process.standardOutput = FileHandle.standardError  // a pusher's chatter is not the snapshot
process.standardError = FileHandle.standardError
do {
  try process.run()
} catch {
  fail(6, "could not start the pusher: " + error.localizedDescription)
}
input.fileHandleForWriting.write(payload)
try? input.fileHandleForWriting.close()
process.waitUntilExit()
if process.terminationStatus != 0 {
  fail(6, "the pusher exited \(process.terminationStatus)")
}
print("pushed: \(records.count) events, window \(iso.string(from: windowStart))..\(iso.string(from: windowEnd))")
