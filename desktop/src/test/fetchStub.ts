/* An in-memory `fetch`, for code that talks to a third-party HTTP API directly.
 *
 * The Supabase calls go through `restStub` because they go through Rust; the cloud providers call
 * `fetch` from the webview, so they need this instead. Same principle as the other harnesses: a real
 * test must be able to assert WHICH request was made, not just that the function returned.
 *
 * Unrouted requests answer `200 {}` and are recorded, so a test only has to describe the responses
 * it actually cares about — but `unrouted()` is there when "nothing else was called" is the point.
 */

export interface Reply {
  status?:  number;
  json?:    unknown;
  text?:    string;
  headers?: Record<string, string>;
}

export interface FetchCall {
  url:     string;
  method:  string;
  headers: Record<string, string>;
  body:    unknown;
  /** Request body read back as form fields — the OAuth token endpoints post urlencoded. */
  form(): Record<string, string>;
  /** Request body read back as JSON — Graph and Drive post JSON metadata. */
  json(): unknown;
  /** Byte length of a binary body, which is what the chunking logic is judged on. */
  size(): number;
}

interface Route {
  match: RegExp;
  reply: Reply | ((call: FetchCall) => Reply);
  used:  number;
}

export interface FetchStub {
  calls: FetchCall[];
  /** Register a response. Later routes win over earlier ones, so a test can override a default. */
  route(match: RegExp, reply: Reply | ((call: FetchCall) => Reply)): FetchStub;
  matching(re: RegExp): FetchCall[];
  one(re: RegExp): FetchCall;
  urls(): string[];
  unrouted(): FetchCall[];
  restore(): void;
}

function makeCall(url: string, init: RequestInit | undefined): FetchCall {
  const body = init?.body;
  return {
    url,
    method:  (init?.method ?? 'GET').toUpperCase(),
    headers: (init?.headers as Record<string, string>) ?? {},
    body,
    form() {
      const text = body instanceof URLSearchParams ? body.toString() : String(body ?? '');
      return Object.fromEntries(new URLSearchParams(text));
    },
    json() {
      if (typeof body === 'string') return JSON.parse(body);
      return body;
    },
    size() {
      if (body instanceof Uint8Array) return body.byteLength;
      if (typeof body === 'string') return body.length;
      return 0;
    },
  };
}

export function installFetchStub(): FetchStub {
  const original = globalThis.fetch;
  const routes: Route[] = [];
  const unroutedCalls: FetchCall[] = [];

  const stub: FetchStub = {
    calls: [],
    route(match, reply) {
      routes.unshift({ match, reply, used: 0 });   // unshift ⇒ last registered is matched first
      return stub;
    },
    matching(re) { return stub.calls.filter(c => re.test(c.url)); },
    one(re) {
      const hits = stub.calls.filter(c => re.test(c.url));
      if (hits.length !== 1) {
        throw new Error(`Expected exactly 1 request matching ${re}, got ${hits.length}:\n  ${stub.urls().join('\n  ')}`);
      }
      return hits[0];
    },
    urls() { return stub.calls.map(c => `${c.method} ${c.url}`); },
    unrouted() { return unroutedCalls; },
    restore() { globalThis.fetch = original; },
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url  = typeof input === 'string' ? input : input.toString();
    const call = makeCall(url, init);
    stub.calls.push(call);

    const route = routes.find(r => r.match.test(url));
    if (!route) unroutedCalls.push(call);
    const raw = route ? (typeof route.reply === 'function' ? route.reply(call) : route.reply) : {};
    if (route) route.used += 1;

    const status = raw.status ?? 200;
    const text   = raw.text ?? JSON.stringify(raw.json ?? {});
    return {
      ok:      status >= 200 && status < 300,
      status,
      headers: new Map(Object.entries(raw.headers ?? {})),
      text:    async () => text,
      json:    async () => (raw.json !== undefined ? raw.json : JSON.parse(text)),
    };
  }) as unknown as typeof fetch;

  return stub;
}
