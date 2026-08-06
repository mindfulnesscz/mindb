/* A recording stand-in for the Rust command bridge (`@tauri-apps/api/core`).
 *
 * The CDN stages' entire contract with Rust is the argument object they pass to
 * `upload_to_r2` — above all the `objectKey`, which is the permanent address of a
 * published asset. Recording those calls is how a test can assert the key without a
 * bucket. Thumbnail generation writes into the virtual filesystem so the CDN stage that
 * follows sees a real file to stat.
 */

import { vfs } from './vfs';

export interface UploadArgs {
  filePath: string;
  objectKey: string;
  contentType: string;
  remoteExists: boolean | null;
  knownSha256: string | null;
  [k: string]: unknown;
}

class InvokeStub {
  calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  /** Keys R2 reports as already present. */
  remoteKeys = new Set<string>();
  /** Make `list_r2_keys` fail, to exercise the per-file fallback path. */
  listFails = false;
  /** Make `upload_to_r2` report a content-hash match (no bytes transferred). */
  uploadSkipped = false;
  /** Make `generate_thumbnail` / `generate_document_previews` fail. */
  thumbnailFails = false;
  /** Page count `generate_document_previews` reports. Above a job's `limit`, rendering is capped
   *  while `total` still reports this — the difference is what the portal shows as "download for
   *  the rest". */
  documentPages = 1;
  sha256 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  /**
   * Canned replies for commands with no built-in behaviour — the cloud bridge
   * (`upload_to_dropbox`, `onedrive_refresh_token`, …), where the point of the test is the
   * arguments handed to Rust rather than anything the fake does with them.
   */
  replies = new Map<string, unknown>();
  private thumbnailFingerprints = new Map<
    string,
    { mtimeMs: number; size: number; width: number; quality: number }
  >();

  reset(): void {
    this.calls = [];
    this.remoteKeys = new Set();
    this.listFails = false;
    this.uploadSkipped = false;
    this.thumbnailFails = false;
    this.documentPages = 1;
    this.replies = new Map();
    this.thumbnailFingerprints = new Map();
  }

  /** Args of every call to `cmd`, in order. */
  argsFor(cmd: string): Array<Record<string, unknown>> {
    return this.calls.filter(c => c.cmd === cmd).map(c => c.args);
  }

  /** Every objectKey passed to upload_to_r2, sorted. */
  uploadedKeys(): string[] {
    return this.argsFor('upload_to_r2').map(a => a.objectKey as string).sort();
  }

  deletedKeys(): string[] {
    return this.argsFor('delete_r2_object').map(a => a.objectKey as string).sort();
  }

  invoke = async (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    this.calls.push({ cmd, args });
    switch (cmd) {
      case 'files_equal':
        return vfs.sameContent(
          args.sourcePath as string,
          args.destinationPath as string,
        );
      case 'generate_thumbnail': {
        if (this.thumbnailFails) throw new Error('thumbnail generation failed');
        const info = await vfs.fsApi().stat(args.src as string);
        const fingerprint = {
          mtimeMs: info.mtime?.getTime() ?? -1,
          size: info.size,
          width: args.width as number,
          quality: args.quality as number,
        };
        const previous = this.thumbnailFingerprints.get(args.dest as string);
        if (vfs.hasFile(args.dest as string)
            && previous
            && previous.mtimeMs === fingerprint.mtimeMs
            && previous.size === fingerprint.size
            && previous.width === fingerprint.width
            && previous.quality === fingerprint.quality) {
          return false;
        }
        vfs.put(args.dest as string, 'webp-bytes');
        this.thumbnailFingerprints.set(args.dest as string, fingerprint);
        return true;
      }
      /* Documents take this path instead: ONE call produces the title thumbnail and the page
         previews, because Rust reuses a single LibreOffice conversion (see render.rs). The fake
         mirrors that contract — it writes the thumbnail AND the page files, so tests that only care
         about the thumbnail behave as they did before this command existed. */
      case 'generate_document_previews': {
        if (this.thumbnailFails) throw new Error('thumbnail generation failed');
        vfs.put(args.thumb as string, 'webp-bytes');
        const rendered = Math.min(this.documentPages, (args.limit as number) ?? 0);
        const pagesDir = args.pagesDir as string;
        for (let p = 1; p <= rendered; p++) {
          vfs.put(`${pagesDir}/${String(p).padStart(3, '0')}.webp`, 'webp-bytes');
        }
        /* pages.json last, as Rust does — it is what marks the set complete, and the upload stage
           reads it rather than listing the directory, so a fake without it publishes nothing. */
        vfs.put(`${pagesDir}/pages.json`, JSON.stringify({
          version: 1, srcMtimeMs: 0, srcSize: 0,
          total: this.documentPages, rendered,
          limit: args.limit, width: args.width, quality: args.quality,
        }));
        // `total` is the document's real page count even when `rendered` is capped below it.
        return { total: this.documentPages, rendered, cached: false };
      }
      case 'list_r2_keys': {
        if (this.listFails) throw new Error('list failed');
        const prefix = (args.prefix as string) ?? '';
        return [...this.remoteKeys].filter(k => k.startsWith(prefix));
      }
      case 'upload_to_r2': {
        const objectKey = args.objectKey as string;
        this.remoteKeys.add(objectKey);
        return {
          // Mirrors the real command: public URL with a content-hash cache buster.
          url: `${args.publicDomain as string}/${objectKey}?v=${this.sha256.slice(0, 12)}`,
          skipped: this.uploadSkipped,
          sha256: this.sha256,
        };
      }
      case 'delete_r2_object':
        this.remoteKeys.delete(args.objectKey as string);
        return null;
      default:
        return this.replies.get(cmd) ?? {};
    }
  };
}

export const invokeStub = new InvokeStub();
