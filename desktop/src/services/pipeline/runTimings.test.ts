/* The run-timings history: what gets written, and — the part that actually matters — which
   previous run a new one is allowed to be compared against. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', async () => (await import('../../test/vfs')).vfs.fsApi());
vi.mock('@tauri-apps/api/path', async () => (await import('../../test/vfs')).vfs.pathApi());

const { vfs } = await import('../../test/vfs');
const {
  RUN_TIMINGS_FILE, loadRunTimings, appendRunTiming, findBaseline, toBaseline,
  buildRunRecord, enabledStages,
} = await import('./runTimings');
const { beginRunTimeline, endRunTimeline, timePhase, timeStep } = await import('./timing');
const { makeSettings } = await import('../../test/pipelineHarness');

import type { RunTimingRecord } from './runTimings';

const PATH = `/appdata/${RUN_TIMINGS_FILE}`;

function record(over: Partial<RunTimingRecord> = {}): RunTimingRecord {
  return {
    at: '2026-08-07T09:00:00.000Z',
    clientId: 'client-a',
    client: 'Client A',
    appVersion: '3.2.2',
    stages: ['doPublish', 'doThumbnails'],
    dryRun: false,
    assets: 300,
    errors: 0,
    stopped: false,
    totalMs: 192_000,
    measuredMs: 144_000,
    phases: [['THUMBNAILS', 41_000], ['SUPABASE EXPORT', 48_000]],
    steps: [['SUPABASE EXPORT › writes', 44_800]],
    ...over,
  };
}

beforeEach(() => vfs.reset());

describe('the history file', () => {
  it('round-trips a run, one JSON object per line', async () => {
    await appendRunTiming(record());
    await appendRunTiming(record({ at: '2026-08-07T10:00:00.000Z', totalMs: 125_000 }));

    const raw = await vfs.fsApi().readTextFile(PATH);
    expect(raw.trimEnd().split('\n')).toHaveLength(2);

    const history = await loadRunTimings();
    expect(history.map(r => r.totalMs)).toEqual([192_000, 125_000]);
  });

  it('skips a corrupt line rather than losing the file', async () => {
    await vfs.fsApi().writeTextFile(PATH,
      `${JSON.stringify(record())}\n{ this is not json\n${JSON.stringify(record({ totalMs: 5 }))}\n`);
    expect((await loadRunTimings()).map(r => r.totalMs)).toEqual([192_000, 5]);
  });

  it('reads as empty when nothing has been written yet', async () => {
    expect(await loadRunTimings()).toEqual([]);
  });

  it('caps the file so a daily run cannot grow it forever', async () => {
    const many = Array.from({ length: 505 }, (_, i) => JSON.stringify(record({ totalMs: i })));
    await vfs.fsApi().writeTextFile(PATH, many.join('\n') + '\n');
    await appendRunTiming(record({ totalMs: 9_999 }));

    const history = await loadRunTimings();
    expect(history).toHaveLength(500);
    expect(history.at(-1)!.totalMs).toBe(9_999);
    expect(history[0].totalMs).toBe(6); // the oldest six fell off
  });
});

describe('choosing a baseline', () => {
  const current = { clientId: 'client-a', stages: ['doPublish', 'doThumbnails'], dryRun: false };

  it('takes the most recent matching run', () => {
    const history = [
      record({ at: '2026-08-05T09:00:00.000Z', totalMs: 1 }),
      record({ at: '2026-08-06T09:00:00.000Z', totalMs: 2 }),
    ];
    expect(findBaseline(history, current)?.totalMs).toBe(2);
  });

  it('refuses a run of a different client', () => {
    expect(findBaseline([record({ clientId: 'client-b' })], current)).toBeNull();
  });

  it('refuses a run with different stages enabled', () => {
    // Thumbnails off is not "faster" — it is a different run, and comparing them invents a win.
    expect(findBaseline([record({ stages: ['doPublish'] })], current)).toBeNull();
  });

  it('refuses a dry run as the baseline for a real one', () => {
    expect(findBaseline([record({ dryRun: true })], current)).toBeNull();
  });

  it('refuses a stopped run, which is only ever a partial measurement', () => {
    expect(findBaseline([record({ stopped: true })], current)).toBeNull();
  });

  it('ignores asset count, and reports it instead', () => {
    const baseline = findBaseline([record({ assets: 12 })], current);
    expect(baseline).not.toBeNull();
    expect(toBaseline(baseline!).describedAs).toContain('12 asset(s)');
    expect(toBaseline(baseline!).describedAs).toContain('3.2.2');
  });

  it('exposes the previous phases by label for the delta column', () => {
    expect(toBaseline(record()).phases).toEqual({
      'THUMBNAILS': 41_000,
      'SUPABASE EXPORT': 48_000,
    });
  });
});

describe('building a record from a finished timeline', () => {
  afterEach(() => endRunTimeline());

  it('captures every phase and step, not only the ranked top five', () => {
    beginRunTimeline();
    for (let i = 0; i < 8; i++) timePhase(`P${i}`).done();
    timeStep('P0 › inner').done();

    const built = buildRunRecord({
      settings: makeSettings({ doThumbnails: true, doPublish: true }),
      clientId: 'client-a', clientName: 'Client A', appVersion: '3.2.2',
      assets: 300, errors: 0, stopped: false,
      at: new Date('2026-08-07T09:00:00.000Z'),
    })!;

    expect(built.phases.map(([label]) => label)).toHaveLength(8);
    expect(built.steps).toEqual([['P0 › inner', 0]]);
    expect(built.stages).toEqual(['doPublish', 'doThumbnails']);
    expect(built.at).toBe('2026-08-07T09:00:00.000Z');
    expect(built.client).toBe('Client A');
  });

  it('returns null when no run was timed', () => {
    endRunTimeline();
    expect(buildRunRecord({
      settings: makeSettings(), clientId: null, clientName: null, appVersion: '3.2.2',
      assets: 0, errors: 0, stopped: false,
    })).toBeNull();
  });
});

describe('enabledStages', () => {
  it('is sorted, so two runs with the same stages produce the same key', () => {
    expect(enabledStages(makeSettings({ doPublish: true, doThumbnails: true })))
      .toEqual(enabledStages(makeSettings({ doThumbnails: true, doPublish: true })));
  });

  it('lists only what is on', () => {
    expect(enabledStages(makeSettings({ doThumbnails: true }))).toEqual(['doThumbnails']);
    expect(enabledStages(makeSettings())).toEqual([]);
  });
});
