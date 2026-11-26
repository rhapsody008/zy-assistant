// The morning briefing, as the CLI reads it: the rules' briefing, and only that.
// It is built in src/rules.ts, next to the rules that produce it, because it is a
// function of the board alone: no store, no history, no clock.

export { brief, type Brief } from "./rules.ts";
