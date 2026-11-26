// The briefing is written in Slack's markup, because Slack is where it was read:
// `<url|ref>` for a link and `*word*` for emphasis. The CLI prints the same text
// into a file or a terminal, so it renders those two forms into the shape the
// reader understands. A renderer, not a second briefing: the words are the rules'.

import type { Brief } from "./brief.ts";

export type Links = "md" | "plain" | "slack";

/** Slack's link and its emphasis, the two marks the other shapes spell differently. */
const LINK = /<([^|>]+)\|([^>]+)>/g;
const EMPHASIS = /\*([^*\n]+)\*/g;

/**
 * The briefing's markup in the requested shape: `slack` keeps it, `md` writes a
 * markdown link and **double** emphasis, `plain` puts the url behind its text in
 * parentheses and drops the asterisks.
 */
export function renderText(s: string, links: Links): string {
  switch (links) {
    case "slack":
      return s;
    case "md":
      return s.replace(LINK, "[$2]($1)").replace(EMPHASIS, "**$1**");
    case "plain":
      return s.replace(LINK, "$2 ($1)").replace(EMPHASIS, "$1");
  }
}

/** The whole briefing as one string, head, rows and tail. */
export function renderBrief(b: Brief, links: Links): string {
  return renderText(b.text, links);
}
