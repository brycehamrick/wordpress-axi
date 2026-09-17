/**
 * WordPress returns titles, excerpts, and content as HTML fragments in
 * `{ rendered: "..." }` objects. For compact list output we strip tags and
 * decode the common entities so one row stays one line.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
};

export function stripHtml(html: string): string {
  const withoutTags = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(withoutTags).replace(/\s+/g, " ").trim();
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/** Flatten a WordPress `{ rendered | raw }` field to plain text. */
export function renderedText(field: unknown): string | undefined {
  if (typeof field === "string") return field;
  if (field !== null && typeof field === "object" && "rendered" in (field as Record<string, unknown>)) {
    const value = (field as Record<string, unknown>)["rendered"];
    if (typeof value === "string") return stripHtml(value);
  }
  return undefined;
}

/** WordPress returns dates like "2026-01-15T10:30:00"; lists want the date. */
export function shortDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.slice(0, 10);
}
