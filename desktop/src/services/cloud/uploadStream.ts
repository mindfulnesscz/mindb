/* The one way bytes leave this machine for a cloud destination.
 *
 * Every provider used to buffer a whole deliverable before sending it, just in different places:
 * Drive and OneDrive pulled it across the IPC bridge into the webview and posted it from there
 * (twice-copied, resident for the length of the transfer), and Dropbox did the same thing in Rust.
 * `cloud_upload_stream` reads the file — or one byte range of it — straight off disk into the
 * request body, so peak memory is a read buffer whatever the file's size.
 *
 * What stays HERE, in JavaScript, is everything that is actually provider knowledge: auth, folder
 * resolution, the skip decision, which upload shape a file needs, the exact URL and headers. Only
 * the transfer moved. That split is why a provider change is still a change to one small module and
 * not to Rust.
 *
 * Small files deliberately do NOT use this. Drive's multipart create (≤5 MiB) interleaves metadata
 * with the bytes in one body, and OneDrive's simple PUT (≤4 MiB) is a single request — both are
 * bounded by a limit the provider sets, both are simpler read whole, and neither is what makes a run
 * slow. The threshold each provider already had is the threshold for streaming.
 */

import { invoke } from '@tauri-apps/api/core';

/** A file to be uploaded: where it is, and — for the small in-memory paths only — its bytes. */
export interface UploadSource {
  path:  string;
  bytes: () => Promise<Uint8Array<ArrayBuffer>>;
}

export interface StreamUploadResult {
  status: number;
  body:   string;
  ok:     boolean;
}

/**
 * Stream `filePath` (or `length` bytes of it from `offset`) as the body of one request.
 *
 * `Content-Length` is set natively from the range actually being sent — never pass one. Rust
 * validates the range against the file before opening a connection, because a body shorter than its
 * declared length does not fail against these providers, it HANGS.
 *
 * The destination host is checked against an allowlist in Rust before a byte is read. That is a
 * security boundary, not a convenience: this command can read any path-policy-allowed file and send
 * it anywhere with a caller-supplied `Authorization` header.
 */
export async function streamUpload(opts: {
  url:     string;
  method:  'PUT' | 'POST' | 'PATCH';
  headers: Record<string, string>;
  filePath: string;
  offset?: number;
  length?: number;
}): Promise<StreamUploadResult> {
  const res = await invoke<{ status: number; body: string }>('cloud_upload_stream', {
    url:      opts.url,
    method:   opts.method,
    headers:  Object.entries(opts.headers),
    filePath: opts.filePath,
    offset:   opts.offset ?? null,
    length:   opts.length ?? null,
  });
  return { ...res, ok: res.status >= 200 && res.status < 300 };
}

/** Provider responses are JSON, but an error body may not be — never let a parse failure become the
 *  reported cause of a failed upload. */
export function parseUploadBody<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}
