/* Log buffering and progress throttling.
 *
 * The run emits a log line and a progress tick per file. Each used to be its own store update, so
 * a large library caused thousands of main-thread React renders while the run was competing for
 * that same thread. Buffering is only acceptable if it changes NOTHING a reader can observe once
 * the dust settles: same lines, same order, same types, and a stage banner still lands the moment
 * it is written. That is what these tests pin.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../services/reportError', () => ({ addBreadcrumb: () => {} }));

const { usePipelineStore } = await import('./pipelineStore');

const store = () => usePipelineStore.getState();
const messages = () => store().log.map(l => l.message);

beforeEach(() => {
  vi.useFakeTimers();
  // `startRun` is the store's own reset for the buffering state (buffer, flush timer, throttle
  // clock) — the point being that a run always starts from a clean one, whatever the last did.
  store().startRun();
  store().clearLog();
});

describe('appendLog buffering', () => {
  it('holds ordinary lines out of the store until the flush interval elapses', () => {
    store().appendLog('info', 'one');
    store().appendLog('success', 'two');
    expect(store().log).toHaveLength(0);

    vi.advanceTimersByTime(100);
    expect(messages()).toEqual(['one', 'two']);
  });

  it('flushes a section banner synchronously, carrying everything buffered before it', () => {
    store().appendLog('info', 'file a');
    store().appendLog('info', 'file b');
    store().appendLog('section', '━━━ THUMBNAILS DONE ━━━');

    // No timer advance: the banner is in the store, and the lines that preceded it came with it.
    expect(messages()).toEqual(['file a', 'file b', '━━━ THUMBNAILS DONE ━━━']);
  });

  it('never reorders — a buffered line always precedes what was logged after it', () => {
    for (let i = 0; i < 50; i++) store().appendLog('dim', `line ${i}`);
    store().appendLog('section', 'banner');
    for (let i = 50; i < 60; i++) store().appendLog('dim', `line ${i}`);
    vi.advanceTimersByTime(100);

    expect(messages()).toEqual([
      ...Array.from({ length: 50 }, (_, i) => `line ${i}`),
      'banner',
      ...Array.from({ length: 10 }, (_, i) => `line ${i + 50}`),
    ]);
  });

  it('keeps the type and the timestamp of every line', () => {
    store().appendLog('error', 'boom');
    vi.advanceTimersByTime(100);
    expect(store().log[0].type).toBe('error');
    expect(store().log[0].timestamp).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('collapses many lines into one store update', () => {
    let updates = 0;
    const unsubscribe = usePipelineStore.subscribe(() => { updates += 1; });
    for (let i = 0; i < 200; i++) store().appendLog('dim', `line ${i}`);
    vi.advanceTimersByTime(100);
    unsubscribe();

    expect(store().log).toHaveLength(200);
    expect(updates).toBe(1);
  });

  it('flushes on demand, and on finishRun — nothing is lost when the run ends', () => {
    store().appendLog('info', 'pending');
    store().flushLog();
    expect(messages()).toEqual(['pending']);

    store().appendLog('info', 'last');
    store().finishRun(store().stats, false);
    expect(messages()).toEqual(['pending', 'last']);
    expect(store().runStatus).toBe('completed');
  });

  it('drops the buffer on clearLog rather than flushing it into an emptied log', () => {
    store().appendLog('info', 'gone');
    store().clearLog();
    vi.advanceTimersByTime(100);
    expect(store().log).toEqual([]);
  });
});

describe('setProgress throttling', () => {
  it('applies the first value immediately', () => {
    store().setProgress(5);
    expect(store().progress).toBe(5);
  });

  it('coalesces a burst and still delivers the LAST value', () => {
    store().setProgress(1);
    for (let p = 2; p <= 99; p++) store().setProgress(p);
    // Still on the first value — the burst was inside the throttle window.
    expect(store().progress).toBe(1);

    vi.advanceTimersByTime(100);
    expect(store().progress).toBe(99);
  });

  it('does not let a trailing update land after the run finished at 100', () => {
    store().setProgress(1);
    store().setProgress(42);
    store().finishRun(store().stats, false);
    expect(store().progress).toBe(100);

    vi.advanceTimersByTime(500);
    expect(store().progress).toBe(100);
  });

  it('starts a new run from zero with no stale trailing value', () => {
    store().setProgress(1);
    store().setProgress(88);
    store().startRun();
    expect(store().progress).toBe(0);

    vi.advanceTimersByTime(500);
    expect(store().progress).toBe(0);
  });
});
