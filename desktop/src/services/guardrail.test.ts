/* The blast-radius guardrail.
 *
 * These numbers decide whether a bad run costs a re-run or a client's asset history, so the boundary
 * cases are pinned rather than left to reading the arithmetic. The two shapes that matter are the ones
 * real incidents had: many deletions against ZERO writes (wrong tenant, or an unreadable source), and
 * many deletions against a few writes (a partial view of the source tree).
 */

import { describe, it, expect } from 'vitest';
import {
  assessDestruction, assessFreshDestruction, assessReconciliationRead,
  assessTargetReconciliationRead, DESTRUCTION_FLOOR,
} from './guardrail';

const assess = (doomed: number, written: number, allowLarge = false) =>
  assessDestruction({ unit: 'row(s)', doomed, written, allowLarge });

describe('assessDestruction — the shapes real incidents had', () => {
  it('BLOCKS many deletions against zero writes', () => {
    // F-9: a fixture sync against a populated client disconnected all 17 of its assets.
    const r = assess(17, 0);
    expect(r.blocked).toBe(true);
    expect(r.message).toMatch(/REFUSING to remove 17 row\(s\)/);
  });

  it('BLOCKS many deletions against a few writes', () => {
    // A partly readable source: seven packages found, hundreds of rows look absent.
    expect(assess(200, 7).blocked).toBe(true);
  });

  it('allows a normal run — a lot written, a little stale', () => {
    expect(assess(3, 120).blocked).toBe(false);
  });

  it('says what it is doing even when it allows the deletion', () => {
    // A silent destructive stage is how the F-9 disconnect went unnoticed for a day.
    expect(assess(3, 120).message).toContain('3 row(s) to remove');
    expect(assess(3, 120).message).toContain('run wrote 120');
  });
});

describe('assessDestruction — the floor', () => {
  it('allows small deletions regardless of writes, because small numbers are noise', () => {
    // A package losing its last two files legitimately disconnects two rows and writes none.
    expect(assess(2, 0).blocked).toBe(false);
    expect(assess(DESTRUCTION_FLOOR, 0).blocked).toBe(false);
  });

  it('starts blocking one past the floor when nothing was written', () => {
    expect(assess(DESTRUCTION_FLOOR + 1, 0).blocked).toBe(true);
  });

  it('lets the write count raise the allowance above the floor', () => {
    // 40 written earns 40 allowed, so a genuine large reorganisation is not obstructed.
    expect(assess(40, 40).blocked).toBe(false);
    expect(assess(41, 40).blocked).toBe(true);
  });
});

describe('assessDestruction — nothing to do', () => {
  it('is silent when there is nothing to destroy', () => {
    // The stage returns early anyway; an empty message keeps the log free of no-op noise.
    expect(assess(0, 100)).toEqual({ blocked: false, message: '' });
    expect(assess(0, 0)).toEqual({ blocked: false, message: '' });
  });

  it('treats a negative count as nothing, not as a licence', () => {
    expect(assess(-5, 0).blocked).toBe(false);
  });
});

describe('assessDestruction — the operator opt-in', () => {
  it('proceeds when the run option is set', () => {
    const r = assess(500, 0, true);
    expect(r.blocked).toBe(false);
  });

  it('still records that it was an override, not a normal run', () => {
    // The log has to distinguish "this was fine" from "a human overrode the tripwire".
    const r = assess(500, 0, true);
    expect(r.message).toMatch(/⚠/);
    expect(r.message).toContain('Allow large deletions');
    expect(r.message).toContain('500');
  });

  it('does not mention the override when it was not needed', () => {
    expect(assess(3, 120, true).message).not.toContain('Allow large deletions');
  });
});

describe('assessDestruction — the refusal message', () => {
  const message = assess(17, 0).message;

  it('names the plausible causes, since the operator has to choose what to check', () => {
    expect(message).toMatch(/source folder/i);
    expect(message).toMatch(/wrong client/i);
  });

  it('states plainly that nothing was removed', () => {
    // Otherwise the operator cannot tell a refusal from a partial deletion.
    expect(message).toMatch(/Nothing was removed/i);
  });

  it('says how to proceed deliberately', () => {
    expect(message).toContain('Allow large deletions');
  });

  it('carries the unit it was given, so the log reads correctly for objects too', () => {
    expect(assessDestruction({ unit: 'CDN object(s)', doomed: 40, written: 0 }).message)
      .toContain('40 CDN object(s)');
  });
});

describe('fresh-source and read-integrity guardrails', () => {
  it('refuses even a small deletion when the authoritative source is stale', () => {
    const result = assessFreshDestruction({
      unit: 'portal tag(s)', doomed: 1, written: 20,
      sourceFresh: false, source: 'the local vocabulary',
    });
    expect(result.blocked).toBe(true);
    expect(result.message).toContain('not freshly synchronized');
  });

  it('applies the normal blast-radius ratio once the source is fresh', () => {
    expect(assessFreshDestruction({
      unit: 'portal tag(s)', doomed: 40, written: 1,
      sourceFresh: true, source: 'the local vocabulary',
    }).blocked).toBe(true);
  });

  it('blocks reconciliation for an unreadable subtree and names both paths', () => {
    const result = assessReconciliationRead('/source/asset/OUT', '/target/asset', 'denied');
    expect(result.blocked).toBe(true);
    expect(result.message).toContain('/source/asset/OUT');
    expect(result.message).toContain('/target/asset');
  });

  it('blocks classification of an unreadable target subtree', () => {
    const result = assessTargetReconciliationRead('/target/protected', 'denied');
    expect(result.blocked).toBe(true);
    expect(result.message).toContain('/target/protected');
  });
});
