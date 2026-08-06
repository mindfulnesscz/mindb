/* What the Run button resolves to.
 *
 * These rules decide WHERE a client's deliverables land and WHICH stages run. Getting the target
 * folder from the wrong place is the shape of bug that shows up as "the destination got wiped" — the
 * run succeeds, into somewhere nobody was looking.
 *
 * The overrides also have to be one-directional: a destination may turn a stage ON, but a checked
 * destination must not turn a stage the operator deliberately unchecked back on.
 */

import { describe, it, expect } from 'vitest';
import { resolveRunPlan, countTasksOn, canRunPipeline, destSummaryLabel } from './runPlan';
import { DEFAULT_SETTINGS, type AppSettings } from '../../store/settingsStore';
import type { CloudDestination } from '../../domain/client';

const settings = (over: Partial<AppSettings> = {}): AppSettings => ({
  ...DEFAULT_SETTINGS, sourceFolder: '/src', ...over,
});

const local = (path: string, id = 'l1'): CloudDestination => ({
  id, name: 'Local', enabled: true, config: { type: 'local', path },
} as CloudDestination);

const cloud = (type: 'dropbox' | 'onedrive' | 'gdrive', id = 'c1'): CloudDestination => ({
  id, name: type, enabled: true, config: { type, remotePath: `/Sotto/${type}` },
} as CloudDestination);

describe('resolveRunPlan — the export target', () => {
  it('takes the target folder from the checked local destination', () => {
    const { effectiveSettings } = resolveRunPlan(
      settings({ targetFolder: '/stale/legacy' }), [local('/Clients/ESS/DELIVERY')],
    );
    expect(effectiveSettings.targetFolder).toBe('/Clients/ESS/DELIVERY');
  });

  it('falls back to the legacy targetFolder setting when no local destination is checked', () => {
    // Clients configured before destinations existed still run from this single setting.
    const { effectiveSettings } = resolveRunPlan(settings({ targetFolder: '/legacy' }), [cloud('dropbox')]);
    expect(effectiveSettings.targetFolder).toBe('/legacy');
  });

  it('uses the FIRST checked local destination when several are checked', () => {
    // A single run has one local target; documenting which one it is beats leaving it to array order
    // at the call site.
    const { effectiveSettings, localDest } = resolveRunPlan(
      settings(), [local('/first', 'a'), local('/second', 'b')],
    );
    expect(localDest?.id).toBe('a');
    expect(effectiveSettings.targetFolder).toBe('/first');
  });

  it('leaves the target folder alone when nothing is checked at all', () => {
    const { effectiveSettings, localDest, cloudDests } = resolveRunPlan(settings({ targetFolder: '/kept' }), []);
    expect(effectiveSettings.targetFolder).toBe('/kept');
    expect(localDest).toBeNull();
    expect(cloudDests).toEqual([]);
  });
});

describe('resolveRunPlan — which stages the destinations imply', () => {
  it('turns Export ON for a checked local destination even when task 4 is unchecked', () => {
    // The destination checkbox IS the control. Without this the operator ticks a destination, runs,
    // and nothing is exported.
    const { effectiveSettings } = resolveRunPlan(settings({ doPublish: false }), [local('/out')]);
    expect(effectiveSettings.doPublish).toBe(true);
  });

  it('leaves Export as configured when only cloud destinations are checked', () => {
    expect(resolveRunPlan(settings({ doPublish: false }), [cloud('gdrive')]).effectiveSettings.doPublish).toBe(false);
    expect(resolveRunPlan(settings({ doPublish: true }), [cloud('gdrive')]).effectiveSettings.doPublish).toBe(true);
  });

  it('suppresses Cloud export when no cloud destination is checked', () => {
    // Staging a flat copy nobody consumes costs a full second pass over every asset.
    const { effectiveSettings } = resolveRunPlan(settings({ doFlatExport: true }), [local('/out')]);
    expect(effectiveSettings.doFlatExport).toBe(false);
  });

  it('does NOT turn Cloud export on just because a cloud destination is checked', () => {
    // One-directional: a destination may enable a stage the operator forgot, never one they
    // deliberately turned off.
    const { effectiveSettings } = resolveRunPlan(settings({ doFlatExport: false }), [cloud('dropbox')]);
    expect(effectiveSettings.doFlatExport).toBe(false);
  });

  it('keeps Cloud export on when both a cloud destination and the task are set', () => {
    const { effectiveSettings } = resolveRunPlan(settings({ doFlatExport: true }), [cloud('onedrive'), local('/out')]);
    expect(effectiveSettings.doFlatExport).toBe(true);
  });

  it('passes every non-local destination to the cloud stage, and no local one', () => {
    const { cloudDests } = resolveRunPlan(
      settings(), [local('/out'), cloud('dropbox', 'd'), cloud('gdrive', 'g')],
    );
    expect(cloudDests.map(d => d.id)).toEqual(['d', 'g']);
  });

  it('changes nothing else about the settings', () => {
    // Only three fields are overridden; a fourth appearing here would be a silent behaviour change.
    const input = settings({ targetFolder: '/t', doPublish: false, doFlatExport: true, dryRun: true });
    const { effectiveSettings } = resolveRunPlan(input, [local('/out'), cloud('dropbox')]);

    const changed = Object.keys(input).filter(
      k => input[k as keyof AppSettings] !== effectiveSettings[k as keyof AppSettings],
    );
    expect(changed.sort()).toEqual(['doPublish', 'targetFolder']);
  });
});

describe('canRunPipeline', () => {
  it('allows a run with a source, a destination and at least one task', () => {
    expect(canRunPipeline(settings({ doThumbnails: true }), [local('/out')], 'idle')).toBe(true);
  });

  it('blocks a run with no source folder', () => {
    expect(canRunPipeline(settings({ sourceFolder: '', doThumbnails: true }), [local('/out')], 'idle')).toBe(false);
  });

  it('blocks a run with no destination selected', () => {
    // Otherwise the run reports its own emptiness as a clean run, which reads as "nothing to do".
    expect(canRunPipeline(settings({ doThumbnails: true }), [], 'idle')).toBe(false);
  });

  it('blocks a run with every task off', () => {
    const off = settings({
      doThumbnails: false, doCdnOriginals: false, doDistribute: false,
      doPublish: false, doFlatExport: false, doObsidian: false,
    });
    expect(canRunPipeline(off, [local('/out')], 'idle')).toBe(false);
  });

  it('blocks a second run while one is running or stopping', () => {
    const ok = settings({ doThumbnails: true });
    expect(canRunPipeline(ok, [local('/out')], 'running')).toBe(false);
    expect(canRunPipeline(ok, [local('/out')], 'stopping')).toBe(false);
  });

  it('allows a re-run after completion or failure', () => {
    const ok = settings({ doThumbnails: true });
    expect(canRunPipeline(ok, [local('/out')], 'completed')).toBe(true);
    expect(canRunPipeline(ok, [local('/out')], 'error')).toBe(true);
  });
});

describe('countTasksOn', () => {
  it('counts only the six pipeline stages, not the run options', () => {
    const s = settings({
      doThumbnails: true, doCdnOriginals: true, doDistribute: false,
      doPublish: false, doFlatExport: false, doObsidian: false,
      dryRun: true, allowLargeDeletions: true,
    });
    expect(countTasksOn(s)).toBe(2);
  });
});

describe('destSummaryLabel', () => {
  it('reads "none", "all N" or "n of N"', () => {
    expect(destSummaryLabel(0, 0)).toBe('none');
    expect(destSummaryLabel(3, 3)).toBe('all 3');
    expect(destSummaryLabel(3, 1)).toBe('1 of 3');
    expect(destSummaryLabel(3, 0)).toBe('0 of 3');
  });
});
