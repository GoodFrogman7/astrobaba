import { TAXONOMY } from "./taxonomy";

/**
 * Limits for KYC uploads passed through the web server to the API. The API is authoritative;
 * these checks only stop obviously oversized or wrong requests early. Files are streamed, never
 * written to the web server's disk.
 */
export const MAX_FILE_BYTES = TAXONOMY.kyc.max_file_bytes;
/** Multipart overhead allowance on top of the file itself (boundaries, headers, kind field). */
export const MULTIPART_OVERHEAD = 16 * 1024;
export const MAX_BODY_BYTES = MAX_FILE_BYTES + MULTIPART_OVERHEAD;
export const ALLOWED_TYPES = TAXONOMY.kyc.content_types;
export const DOC_KINDS = ["identity", "qualification", "other"] as const;

export type UploadCheck = { ok: true } | { ok: false; status: number; code: string };

export function checkUploadHeaders(
  contentType: string | null,
  contentLength: string | null,
): UploadCheck {
  if (!contentType || !/^multipart\/form-data;\s*boundary=/i.test(contentType))
    return { ok: false, status: 415, code: "multipart_required" };
  if (contentLength !== null) {
    const n = Number(contentLength);
    if (!Number.isFinite(n) || n < 0) return { ok: false, status: 400, code: "invalid_length" };
    if (n > MAX_BODY_BYTES) return { ok: false, status: 413, code: "file_too_large" };
  }
  return { ok: true };
}

/** Client-side pre-check before uploading (the server re-checks by magic bytes). */
export function checkFile(file: { size: number; type: string }): string | null {
  if (file.size > MAX_FILE_BYTES) return "file_too_large";
  if (!ALLOWED_TYPES.includes(file.type)) return "unsupported_type";
  return null;
}

/** Pass a request body through while counting bytes; errors once the limit is exceeded. */
export function limitStream(
  body: ReadableStream<Uint8Array>,
  max: number,
): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) controller.error(new Error("file_too_large"));
        else controller.enqueue(chunk);
      },
    }),
  );
}
