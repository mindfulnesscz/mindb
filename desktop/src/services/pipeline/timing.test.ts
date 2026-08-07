/* The formatter's boundaries, and the timeline's two rules: sub-steps do not rank, and a phase
   records once however many times its banner asks for the number. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  formatDuration, startTimer, beginRunTimeline, endRunTimeline,
  timePhase, timeStep, runTimelineSummary, logRunTimeline,
} from './timing';
import type { TimelineBaseline } from './timing';

describe('formatDuration', () => {
  it('reports sub-second work in whole milliseconds', () => {
    expect(formatDuration(0.4)).toBe('0ms');
    expect(formatDuration(1)).toBe('1ms');
    expect(formatDuration(640)).toBe('640ms');
    expect(formatDuration(999.4)).toBe('999ms');
  });

  it('switches to tenths of a second at 1s', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(12_400)).toBe('12.4s');
    expect(formatDuration(59_000)).toBe('59.0s');
  });

  it('rolls to minutes rather than printing "60.0s"', () => {
    expect(formatDuration(59_949)).toBe('59.9s');
    expect(formatDuration(59_950)).toBe('1m 0s');
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(192_000)).toBe('3m 12s');
  });

  it('treats nothing-to-report and nonsense alike', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(-5)).toBe('0ms');
    expect(formatDuration(NaN)).toBe('0ms');
    expect(formatDuration(Infinity)).toBe('0ms');
  });
});

describe('startTimer', () => {
  it('measures forward from its creation', () => {
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(1_000);
    const timer = startTimer();
    nowSpy.mockReturnValue(3_500);
    expect(timer.elapsed()).toBe(2_500);
    expect(timer.format()).toBe('2.5s');
    nowSpy.mockRestore();
  });
});

describe('run timeline', () => {
  let nowSpy: ReturnType<typeof vi.spyOn>;
  let clock = 0;

  const advance = (ms: number) => { clock += ms; };

  beforeEach(() => {
    clock = 0;
    nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    beginRunTimeline();
  });
  afterEach(() => {
    endRunTimeline();
    nowSpy.mockRestore();
  });

  it('ranks top-level phases by duration and keeps steps out of the ranking', () => {
    const slow = timePhase('THUMBNAILS');
    advance(40_000);
    slow.done();

    const wrapper = timePhase('SUPABASE EXPORT');
    const step = timeStep('SUPABASE EXPORT › writes');
    advance(30_000);
    step.done();
    wrapper.done();

    const quick = timePhase('PUBLISH');
    advance(2_000);
    quick.done();

    const summary = runTimelineSummary()!;
    expect(summary.slowest.map(p => p.label)).toEqual(['THUMBNAILS', 'SUPABASE EXPORT', 'PUBLISH']);
    // The step's 30s is inside the export's 30s — counting both would inflate the run.
    expect(summary.measuredMs).toBe(72_000);
    expect(summary.totalMs).toBe(72_000);
  });

  it('caps the ranking at topN', () => {
    for (let i = 0; i < 8; i++) {
      const phase = timePhase(`P${i}`);
      advance(1_000 * (i + 1));
      phase.done();
    }
    expect(runTimelineSummary().slowest.map(p => p.label)).toEqual(['P7', 'P6', 'P5', 'P4', 'P3']);
    expect(runTimelineSummary(2).slowest.map(p => p.label)).toEqual(['P7', 'P6']);
  });

  it('records a phase once even when its banner asks twice', () => {
    const phase = timePhase('CDN');
    advance(5_000);
    expect(phase.done()).toBe('5.0s');
    advance(5_000);
    expect(phase.done()).toBe('5.0s');
    expect(runTimelineSummary().slowest).toHaveLength(1);
  });

  it('separates measured time from wall clock so untimed gaps show up', () => {
    advance(10_000); // nothing measures this
    const phase = timePhase('SCAN');
    advance(5_000);
    phase.done();

    const summary = runTimelineSummary()!;
    expect(summary.measuredMs).toBe(5_000);
    expect(summary.totalMs).toBe(15_000);
  });

  it('logs a total and a ranked list', () => {
    const phase = timePhase('THUMBNAILS');
    advance(60_000);
    phase.done();
    advance(40_000);

    const lines: string[] = [];
    logRunTimeline((_type, msg) => lines.push(msg));

    expect(lines[0]).toBe('━━━ RUN TOTAL — 1m 40s ━━━');
    expect(lines[1]).toContain('1. THUMBNAILS');
    expect(lines[1]).toContain('1m 0s');
    expect(lines[1]).toContain('(60%)');
    expect(lines[2]).toBe('  measured 1m 0s of 1m 40s');
    // Nothing to compare against, so nothing is claimed.
    expect(lines.some(l => l.includes('vs previous'))).toBe(false);
  });

  it('reports the full timeline, not just the ranked five', () => {
    for (let i = 0; i < 7; i++) { const p = timePhase(`P${i}`); advance(1_000); p.done(); }
    const step = timeStep('P0 › inner');
    advance(500);
    step.done();

    const summary = runTimelineSummary()!;
    expect(summary.slowest).toHaveLength(5);
    expect(summary.phases).toHaveLength(7);
    expect(summary.steps).toEqual([{ label: 'P0 › inner', ms: 500 }]);
  });
});

describe('comparing against a previous run', () => {
  let nowSpy: ReturnType<typeof vi.spyOn>;
  let clock = 0;
  const advance = (ms: number) => { clock += ms; };

  function render(baseline: TimelineBaseline) {
    const lines: string[] = [];
    logRunTimeline((_type, msg) => lines.push(msg), { baseline });
    return lines;
  }

  beforeEach(() => {
    clock = 0;
    nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    beginRunTimeline();
  });
  afterEach(() => { endRunTimeline(); nowSpy.mockRestore(); });

  const baseline = (phases: Record<string, number>, totalMs: number) =>
    ({ totalMs, phases, describedAs: '07/08/2026 09:20 · 300 asset(s) · 3.2.2' });

  it('puts the change on the headline and on each phase', () => {
    const slow = timePhase('SUPABASE EXPORT');
    advance(6_000);
    slow.done();
    const same = timePhase('THUMBNAILS');
    advance(41_000);
    same.done();

    const lines = render(baseline({ 'SUPABASE EXPORT': 48_000, 'THUMBNAILS': 41_000 }, 120_000));

    expect(lines[0]).toBe('━━━ RUN TOTAL — 47.0s ━━━  (-1m 13s vs previous run)');
    expect(lines.find(l => l.includes('THUMBNAILS'))).toContain('—');       // unchanged
    expect(lines.find(l => l.includes('SUPABASE EXPORT'))).toContain('-42.0s');
    expect(lines.at(-1)).toBe('  vs 07/08/2026 09:20 · 300 asset(s) · 3.2.2');
  });

  it('calls a phase the baseline never had "new", not an infinite regression', () => {
    const fresh = timePhase('CDN PAGES');
    advance(9_000);
    fresh.done();

    const lines = render(baseline({ THUMBNAILS: 41_000 }, 9_000));
    expect(lines.find(l => l.includes('CDN PAGES'))).toContain('new');
  });

  it('treats sub-100ms movement as unchanged, because that is scheduler noise', () => {
    const phase = timePhase('PUBLISH');
    advance(9_050);
    phase.done();

    const lines = render(baseline({ PUBLISH: 9_000 }, 9_000));
    expect(lines.find(l => l.includes('PUBLISH'))).toContain('—');
    expect(lines[0]).not.toContain('+');
  });

  it('shows a regression with a leading plus', () => {
    const phase = timePhase('CLOUD EXPORT');
    advance(50_000);
    phase.done();

    const lines = render(baseline({ 'CLOUD EXPORT': 33_500 }, 33_500));
    expect(lines[0]).toContain('(+16.5s vs previous run)');
    expect(lines.find(l => l.includes('CLOUD EXPORT'))).toContain('+16.5s');
  });
});

describe('without an active run', () => {
  it('still times, and records nothing', () => {
    endRunTimeline();
    expect(timePhase('ORPHAN').done()).toMatch(/ms$|s$/);
    expect(runTimelineSummary()).toBeNull();
    const lines: string[] = [];
    logRunTimeline((_type, msg) => lines.push(msg));
    expect(lines).toEqual([]);
  });
});
