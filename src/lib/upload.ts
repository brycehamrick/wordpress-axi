import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { AxiError } from "axi-sdk-js";

/**
 * Media upload helpers. WordPress accepts a raw binary POST to /wp/v2/media
 * with the file's content type and an RFC 5987-encoded filename in
 * Content-Disposition (carried over from the original Python helper).
 */

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function guessContentType(filePath: string): string {
  const lower = filePath.toLowerCase();
  for (const [extension, type] of Object.entries(CONTENT_TYPES)) {
    if (lower.endsWith(extension)) return type;
  }
  return "application/octet-stream";
}

/** RFC 5987 filename* encoding so non-ASCII filenames survive headers. */
export function contentDisposition(filename: string): string {
  const encoded = encodeURIComponent(filename)
    .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export interface UploadPayload {
  body: Uint8Array;
  contentType: string;
  disposition: string;
  filename: string;
}

/** Read a local file and build the raw upload payload for POST /wp/v2/media. */
export async function buildUploadPayload(filePath: string): Promise<UploadPayload> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(filePath));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AxiError(`cannot read file: ${message}`, "VALIDATION_ERROR");
  }
  const filename = basename(filePath);
  return {
    body: bytes,
    contentType: guessContentType(filePath),
    disposition: contentDisposition(filename),
    filename,
  };
}
