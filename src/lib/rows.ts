/** Small typed accessors for untyped WordPress JSON payloads. */

import { stripHtml } from "./format.js";

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return asArray(value).filter((item): item is Record<string, unknown> => asRecord(item) !== undefined);
}

/** Strip undefined values so TOON output stays compact. */
export function compact(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Project a raw WordPress row onto caller-selected keys (--fields). Values
 * that are `{ rendered }` objects flatten to plain text; ISO datetimes trim
 * to their date part. Unknown keys are dropped silently so a typo cannot
 * leak a full unfiltered row past the token budget.
 */
export function projectRow(
  raw: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = raw[field];
    if (value === undefined) continue;
    if (asRecord(value) !== undefined) {
      const record = asRecord(value);
      const rendered = record?.["rendered"];
      if (typeof rendered === "string") {
        out[field] = stripHtml(rendered);
        continue;
      }
    }
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
      out[field] = value.slice(0, 10);
      continue;
    }
    out[field] = value;
  }
  return out;
}

