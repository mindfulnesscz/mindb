/* A recording stand-in for the Supabase REST layer (services/supabase/rest.ts).
 *
 * `exportAssetsToSupabase` decides which rows are INSERTed, which are PATCHed, and which are
 * soft-disconnected. Those decisions are the whole behaviour, and they are visible entirely in the
 * requests it issues — so recording the requests characterizes the sync without a database.
 *
 * The existing 8 tests for this code path talk to a real local Postgres, which means they are
 * skipped in CI and prove nothing there. This stub is what makes the flow testable in the same
 * hermetic way the pipeline is.
 */

export interface RestCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

export interface StableRow {
  id: string;
  stable_id: string;
  child_id: string;
  thumbnail_url?: string | null;
  download_key?: string | null;
  parent_id?: string | null;
  variant_of?: string | null;
}

class RestStub {
  calls: RestCall[] = [];
  /** Rows `fetchAllForClient` reports as already in the database. */
  existingRows: StableRow[] = [];
  /** Make any request whose URL matches fail, to exercise the error paths. */
  failUrlMatching: RegExp | null = null;
  /** Make `fetchAllForClient` throw, i.e. "could not read existing records". */
  fetchAllThrows = false;
  private idSeq = 0;

  reset(): void {
    this.calls = [];
    this.existingRows = [];
    this.failUrlMatching = null;
    this.fetchAllThrows = false;
    this.idSeq = 0;
  }

  /** Calls of one HTTP method, in order. */
  byMethod(method: string): RestCall[] {
    return this.calls.filter(c => c.method === method);
  }

  /** The row bodies POSTed to /assets — i.e. everything this run CREATED. */
  inserted(): Record<string, unknown>[] {
    return this.calls
      .filter(c => c.method === 'POST' && c.url.includes('/assets') && c.body)
      .map(c => c.body as Record<string, unknown>);
  }

  /** The row bodies PATCHed to a single asset — i.e. everything this run UPDATED. */
  patched(): Record<string, unknown>[] {
    return this.calls
      .filter(c => c.method === 'PATCH' && /\/assets\?id=eq\./.test(c.url) && c.body)
      .map(c => c.body as Record<string, unknown>);
  }

  /** The ids in the batched `status=disconnected` PATCH, if any. */
  disconnectedIds(): string[] {
    const out: string[] = [];
    for (const c of this.calls) {
      if (c.method !== 'PATCH') continue;
      if ((c.body as { status?: string } | null)?.status !== 'disconnected') continue;
      const m = c.url.match(/id=in\.\(([^)]*)\)/);
      if (m) out.push(...m[1].split(',').filter(Boolean));
    }
    return out;
  }

  /** Matches the subset of ./rest that assetExport uses. */
  api() {
    return {
      BATCH: 500,
      makeHeaders: (anonKey: string) => ({ apikey: anonKey, Authorization: 'Bearer test-token' }),

      fetchAllForClient: async <T>(): Promise<T[]> => {
        if (this.fetchAllThrows) throw new Error('simulated read failure');
        return this.existingRows as unknown as T[];
      },

      sbFetch: async (
        url: string,
        options: { method?: string; headers: Record<string, string>; body?: string },
      ) => {
        const method = options.method ?? 'GET';
        this.calls.push({
          url,
          method,
          body: options.body ? (JSON.parse(options.body) as Record<string, unknown>) : null,
        });

        if (this.failUrlMatching?.test(url)) {
          return {
            ok: false, status: 400,
            text: async () => 'simulated failure',
            json: async <T>() => ({}) as T,
          };
        }
        // A POST returns the created row so the caller can wire children to its uuid.
        const created = [{ id: `row-${++this.idSeq}` }];
        return {
          ok: true, status: method === 'POST' ? 201 : 204,
          text: async () => JSON.stringify(created),
          json: async <T>() => created as unknown as T,
        };
      },
    };
  }
}

export const restStub = new RestStub();
