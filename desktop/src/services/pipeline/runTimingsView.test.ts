/* The run history, shaped for reading.
 *
 * This is presentation, but the numbers in it are the same numbers the run log prints — and two
 * surfaces reporting one run must not disagree. So what is pinned here is not the wording: it is
 * that phases are ranked, that shares are of wall clock rather than of measured time, that the
 * 100ms noise floor matches the log's, and that a delta is only ever shown against a run the
 * comparability rule actually allows.
 */

import { describe, it, expect } from 'vitest';
import { buildRunRows } from './runTimingsView';
import type { RunTimingRecord } from './runTimings';

const record = (over: Partial<RunTimingRecord> = {}): RunTimingRecord => ({
  at: '2026-08-07T08:58:03.755Z',
  clientId: 'client-1', client: 'Mucha Family', appVersion: '3.2.2',
  stages: ['doObsidian', 'doPublish'],
  dryRun: false, assets: 29, errors: 0, stopped: false,
  totalMs: 20000, measuredMs: 20000,
  phases: [['PUBLISH', 5000], ['CDN RECONCILE', 15000]],
  steps: [['SUPABASE EXPORT › readmes', 11]],
  ...over,
});

describe('buildRunRows', () => {
  it('ranks phases by duration and reports each as a share of wall clock', () => {
    const [run] = buildRunRows([record()]);

    expect(run.phases.map(p => p.label)).toEqual(['CDN RECONCILE', 'PUBLISH']);
    expect(run.phases[0]).toMatchObject({ duration: '15.0s', share: 75 });
    expect(run.phases[1]).toMatchObject({ duration: '5.0s', share: 25 });
    expect(run.total).toBe('20.0s');
    expect(run.context).toBe('29 assets · 3.2.2 · Mucha Family');
  });

  it('shares are of the WHOLE run, so untimed work is visible rather than hidden', () => {
    // A phase that is half of everything timed is only a quarter of a run that spent half its
    // wall clock somewhere nothing measures. Dividing by measuredMs would report 50% and lose it.
    const [run] = buildRunRows([record({ totalMs: 40000, measuredMs: 20000 })]);

    expect(run.phases[0].share).toBe(38);
    expect(run.unaccounted).toBe('20.0s');
  });

  it('reports newest first, each against the comparable run before it', () => {
    const older = record({ at: '2026-08-06T10:00:00.000Z', totalMs: 12000, phases: [['PUBLISH', 12000]] });
    const newer = record({ at: '2026-08-07T10:00:00.000Z', totalMs: 20000 });

    const rows = buildRunRows([older, newer]);

    expect(rows.map(r => r.totalMs)).toEqual([20000, 12000]);
    expect(rows[0].comparison?.delta).toBe('+8.0s');
    // PUBLISH got faster; CDN RECONCILE did not exist in the baseline at all.
    expect(rows[0].phases.find(p => p.label === 'PUBLISH')?.delta).toBe('-7.0s');
    expect(rows[0].phases.find(p => p.label === 'CDN RECONCILE')?.delta).toBe('new');
    // Nothing precedes the oldest run, so it is shown without invented comparisons.
    expect(rows[1].comparison).toBeNull();
    expect(rows[1].phases.every(p => p.delta === null)).toBe(true);
  });

  it('treats sub-100ms movement as unchanged, exactly as the run log does', () => {
    const older = record({ at: '2026-08-06T10:00:00.000Z', totalMs: 20050 });
    const rows = buildRunRows([older, record({ at: '2026-08-07T10:00:00.000Z' })]);

    expect(rows[0].comparison?.delta).toBe('—');
  });

  it('refuses a delta against a run that is not comparable', () => {
    const rows = buildRunRows([
      record({ at: '2026-08-06T10:00:00.000Z', stages: ['doPublish'] }),          // fewer stages
      record({ at: '2026-08-06T11:00:00.000Z', dryRun: true }),                   // dry run
      record({ at: '2026-08-06T12:00:00.000Z', clientId: 'other' }),              // another client
      record({ at: '2026-08-06T13:00:00.000Z', stopped: true }),                  // partial
      record({ at: '2026-08-07T10:00:00.000Z' }),
    ]);

    expect(rows[0].comparison).toBeNull();
  });

  it('surfaces a run that errored or was stopped, and its steps', () => {
    const [run] = buildRunRows([record({ errors: 2, stopped: true })]);

    expect(run.errors).toBe(2);
    expect(run.stopped).toBe(true);
    expect(run.steps).toEqual([{ label: 'SUPABASE EXPORT › readmes', duration: '11ms' }]);
  });

  it('shows at most `limit` runs, newest first', () => {
    const history = Array.from({ length: 25 }, (_, i) =>
      record({ at: `2026-08-07T10:${String(i).padStart(2, '0')}:00.000Z`, totalMs: 1000 + i }));

    const rows = buildRunRows(history, 10);

    expect(rows).toHaveLength(10);
    expect(rows[0].totalMs).toBe(1024);
    expect(new Set(rows.map(r => r.key)).size).toBe(10);
  });

  it('survives a malformed timestamp rather than rendering "Invalid Date"', () => {
    const [run] = buildRunRows([record({ at: 'not-a-date' })]);
    expect(run.when).toBe('not-a-date');
  });
});
