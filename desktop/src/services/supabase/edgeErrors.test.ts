/* These messages are the only diagnosis anyone gets from a failed run, so they are tested like
 * behaviour rather than treated as copy. The case that prompted this: a staging deploy that had
 * not finished yet reported "check the edge runtime is running", sending someone to Docker on
 * their laptop to debug a CI timing problem. */
import { describe, it, expect } from 'vitest';
import { edgeFunctionError } from './edgeErrors';

const body = (o: unknown) => JSON.stringify(o);

describe('edgeFunctionError', () => {
  /* The regression. Supabase reports a missing function with `message`, the same field the gateway
     uses for a dead runtime — so the 404 has to be checked first or it is misdiagnosed. */
  it('calls a missing function NOT DEPLOYED, not unreachable', () => {
    const e = edgeFunctionError('stream-upload', 404, body({
      code: 'NOT_FOUND', message: 'Requested function was not found',
    }));
    expect(e.message).toContain('not deployed');
    expect(e.message).toContain('supabase functions deploy stream-upload');
    expect(e.message).not.toContain('edge runtime');
    expect(e.message).not.toContain('docker');
  });

  it('names the function that failed, so a run log says which one', () => {
    expect(edgeFunctionError('r2-grant', 404, '{}').message).toContain('r2-grant');
    expect(edgeFunctionError('stream-token', 500, '{}').message).toContain('stream-token');
  });

  it('calls a gateway body unreachable and points at the runtime', () => {
    const e = edgeFunctionError('r2-grant', 503, body({ message: 'name resolution failed' }));
    expect(e.message).toContain('unreachable');
    expect(e.message).toContain('edge runtime');
    expect(e.message).toContain('name resolution failed');
  });

  it('treats 502 and 504 as unreachable even with no parseable body', () => {
    for (const status of [502, 504]) {
      expect(edgeFunctionError('r2-grant', status, 'Bad Gateway').message, String(status))
        .toContain('unreachable');
    }
  });

  /* Our own functions answer with `error`, and those are decisions — "not provisioned", "not
     assigned to this client". Reporting them as infrastructure faults would hide a real answer. */
  it('reports a function refusal as a refusal, using its own wording', () => {
    const e = edgeFunctionError('stream-upload', 503, body({
      error: 'Video not provisioned — missing CF_STREAM_TOKEN',
    }));
    expect(e.message).toContain('refused');
    expect(e.message).toContain('missing CF_STREAM_TOKEN');
    expect(e.message).not.toContain('edge runtime');
  });

  it('prefers the function\'s own error over a platform message when both are present', () => {
    const e = edgeFunctionError('stream-upload', 403, body({
      error: 'Not assigned to this client', message: 'Forbidden',
    }));
    expect(e.message).toContain('Not assigned to this client');
    expect(e.message).not.toContain('Forbidden');
  });

  it('falls back to the raw body when it is not JSON', () => {
    expect(edgeFunctionError('r2-grant', 500, 'upstream exploded').message)
      .toContain('upstream exploded');
  });
});
