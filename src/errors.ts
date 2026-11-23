// One way to say what went wrong, so a log line and a Slack reply agree.

/** The message of a thrown value, whatever was thrown. */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
