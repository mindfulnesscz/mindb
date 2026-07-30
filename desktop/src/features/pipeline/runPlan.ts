/* What a Run button press actually means — as pure functions.
 *
 * The checkbox grid in the sidebar is not the run configuration; it is an INPUT to it. A checked
 * local destination overrides `doPublish`, an unchecked cloud destination suppresses `doFlatExport`,
 * and the destination's own path replaces `settings.targetFolder`. Those overrides are the difference
 * between "exported where the operator expected" and "exported into the last client's folder".
 *
 * They lived inside a 131-line `handleRun` closure, where they could only be verified by doing a real
 * run against a real client. Here they are testable on their own — see runPlan.test.ts.
 */

import type { AppSettings } from '../../store/settingsStore';
import type { CloudDestination, LocalDestConfig } from '../../domain/client';
import type { RunStatus } from '../../store/pipelineStore';

export interface RunPlan {
  /** Settings as the pipeline should see them, with destination overrides applied. */
  effectiveSettings: AppSettings;
  /** The checked local destination, if any — it owns the export target folder. */
  localDest: CloudDestination | null;
  /** Checked destinations that are not local; these drive the cloud export stage. */
  cloudDests: CloudDestination[];
}

export function resolveRunPlan(settings: AppSettings, selectedDests: CloudDestination[]): RunPlan {
  const localDest  = selectedDests.find(d => d.config.type === 'local') ?? null;
  const cloudDests = selectedDests.filter(d => d.config.type !== 'local');

  return {
    localDest,
    cloudDests,
    effectiveSettings: {
      ...settings,
      // The destination's path wins over the legacy single `targetFolder` setting. Falling back to
      // it is what kept multi-destination clients working before destinations existed.
      targetFolder: localDest ? (localDest.config as LocalDestConfig).path : settings.targetFolder,
      // A checked local destination IS the instruction to export — the checkbox is the control, so
      // the operator does not have to also remember to tick task 4.
      doPublish:    localDest ? true : settings.doPublish,
      // Cloud export with nothing to export to would stage a flat copy nobody consumes.
      doFlatExport: cloudDests.length > 0 ? settings.doFlatExport : false,
    },
  };
}

/** The six pipeline stages the operator can switch on. Zero on ⇒ the run would do nothing. */
export function countTasksOn(settings: AppSettings): number {
  return [
    settings.doThumbnails, settings.doCdnOriginals, settings.doDistribute,
    settings.doPublish, settings.doFlatExport, settings.doObsidian,
  ].filter(Boolean).length;
}

/**
 * Every precondition for the Run button, in one place.
 * A run with no source folder or no destination is not a no-op — it reports its own emptiness as a
 * clean run, which reads as "nothing needed doing".
 */
export function canRunPipeline(
  settings: AppSettings, selectedDests: CloudDestination[], runStatus: RunStatus,
): boolean {
  return runStatus !== 'running'
    && runStatus !== 'stopping'
    && countTasksOn(settings) > 0
    && !!settings.sourceFolder
    && selectedDests.length > 0;
}

export function destSummaryLabel(total: number, selected: number): string {
  if (total === 0) return 'none';
  return selected === total ? `all ${total}` : `${selected} of ${total}`;
}
