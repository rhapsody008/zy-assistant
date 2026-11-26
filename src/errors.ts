// One way to say what went wrong, so every line a run prints agrees.

/** The message of a thrown value, whatever was thrown. */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
