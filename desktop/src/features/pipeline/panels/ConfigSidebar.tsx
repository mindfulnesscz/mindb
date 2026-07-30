/* The left sidebar: paths, destinations, tasks, run options, and the Run button.
 *
 * The destination checkboxes are the one piece of state this owns rather than reads. `enabled` is a
 * machine-local pipeline preference — the portal owns destination STRUCTURE — so a toggle writes it
 * straight back to the client file, and the set is rebuilt when the active client changes.
 *
 * What a run then does with those selections lives in ../runPlan.ts and ../useRunPipeline.ts.
 */

import { useEffect, useState } from 'react';
import { AccordionGroup } from '../AccordionGroup';
import { FolderPicker } from '../FolderPicker';
import { useSettingsStore } from '../../../store/settingsStore';
import { usePipelineStore } from '../../../store/pipelineStore';
import { useClientStore } from '../../../store/clientStore';
import { resolveExportShape } from '../../../domain/client';
import type { CloudDestination } from '../../../domain/client';
import { saveClients } from '../../../services/clientService';
import { reportError } from '../../../services/reportError';
import { canRunPipeline, countTasksOn, destSummaryLabel } from '../runPlan';
import { useRunPipeline } from '../useRunPipeline';
import { TaskRow, DestRow } from './rows';
import css from '../PipelineView.module.css';

export function ConfigSidebar() {
  const { settings, setField } = useSettingsStore();
  const { runStatus, progress, stopRun } = usePipelineStore();
  const { clients, activeClientId, updateClient } = useClientStore();
  const activeClient = clients.find(c => c.id === activeClientId) ?? null;

  const destinations = activeClient?.cloudDestinations ?? [];

  const [selectedDestIds, setSelectedDestIds] = useState<Set<string>>(
    () => new Set(destinations.filter((d: CloudDestination) => d.enabled !== false).map((d: CloudDestination) => d.id))
  );

  useEffect(() => {
    setSelectedDestIds(new Set(
      (activeClient?.cloudDestinations ?? [])
        .filter((d: CloudDestination) => d.enabled !== false)
        .map((d: CloudDestination) => d.id)
    ));
  }, [activeClient?.id]);

  function toggleDest(id: string) {
    const nowEnabled = !selectedDestIds.has(id);
    setSelectedDestIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (activeClient) {
      const updatedDestinations = activeClient.cloudDestinations.map(d =>
        d.id === id ? { ...d, enabled: nowEnabled } : d
      );
      updateClient(activeClient.id, { cloudDestinations: updatedDestinations });
      saveClients({ clients: useClientStore.getState().clients, activeClientId: activeClient.id })
        .catch(e => reportError('config.PipelineView.saveClients', e));
      // enabled is machine/pipeline preference — portal owns destination structure.
    }
  }

  const selectedDests = destinations.filter(d => selectedDestIds.has(d.id));
  const localDest     = selectedDests.find(d => d.config.type === 'local');
  const handleRun     = useRunPipeline(selectedDests);

  const isRunning = runStatus === 'running';

  const pathsSet    = [settings.sourceFolder, settings.vaultFolder].filter(Boolean).length;
  const tasksOn     = countTasksOn(settings);
  const destSummary = destSummaryLabel(destinations.length, selectedDests.length);
  const canRun      = canRunPipeline(settings, selectedDests, runStatus);

  return (
    <div className={css.configSidebar}>
      <div className={css.sidebarHeader}>
        <div className={css.sidebarTitle}>Pipeline</div>
        <div className={css.sidebarCaption}>Configure and run the DAM pipeline</div>
      </div>

      <div className={css.accordionScroll}>
        {/* Paths */}
        <AccordionGroup
          label="Paths"
          summary={`${pathsSet} set`}
          defaultOpen
        >
          <FolderPicker
            label="Source folder"
            value={settings.sourceFolder}
            onChange={v => {
              setField('sourceFolder', v);
              if (activeClientId) {
                updateClient(activeClientId, { sourceFolder: v });
                saveClients({ clients: useClientStore.getState().clients, activeClientId })
                  .catch(e => reportError('config.PipelineView.saveClients', e));
              }
            }}
          />
          <FolderPicker
            label="Obsidian vault"
            value={settings.vaultFolder}
            onChange={v => {
              setField('vaultFolder', v);
              if (activeClientId) {
                updateClient(activeClientId, { vaultFolder: v });
                saveClients({ clients: useClientStore.getState().clients, activeClientId })
                  .catch(e => reportError('config.PipelineView.saveClients', e));
              }
            }}
          />
        </AccordionGroup>

        {/* Destinations */}
        <AccordionGroup label="Destinations" summary={destSummary} defaultOpen>
          {destinations.length === 0 ? (
            <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-subtle)', margin: 0 }}>
              No destinations — add them in Settings → Cloud Destinations.
            </p>
          ) : (
            destinations.map(dest => (
              <DestRow
                key={dest.id}
                dest={dest}
                checked={selectedDestIds.has(dest.id)}
                onChange={() => toggleDest(dest.id)}
              />
            ))
          )}
        </AccordionGroup>

        {/* Tasks */}
        <AccordionGroup label="Tasks" summary={`${tasksOn} on`} defaultOpen>
          <TaskRow
            label="1  Generate thumbnails"
            checked={settings.doThumbnails}
            onChange={v => setField('doThumbnails', v)}
          />
          <TaskRow
            label="2  Upload originals to CDN"
            checked={settings.doCdnOriginals}
            onChange={v => setField('doCdnOriginals', v)}
          />
          <TaskRow
            label="3  Distribute packages"
            checked={settings.doDistribute}
            onChange={v => setField('doDistribute', v)}
          />
          <TaskRow
            label="4  Export to destinations"
            checked={settings.doPublish}
            onChange={v => setField('doPublish', v)}
          />
          {(localDest && resolveExportShape(localDest).includePackages
            || selectedDests.some(d => d.config.type !== 'local' && resolveExportShape(d).includePackages)) && (
            <p className="px-3 pb-2 text-[11px] text-[var(--text-muted)]">
              Destinations with nested packages need step 3 first (packages stay inside the folder tree).
            </p>
          )}
          <TaskRow
            label="5  Cloud export"
            checked={settings.doFlatExport}
            onChange={v => setField('doFlatExport', v)}
          />
          <TaskRow
            label="6  Publish to DAM"
            checked={settings.doObsidian}
            onChange={v => setField('doObsidian', v)}
          />
        </AccordionGroup>

        {/* Run options */}
        <AccordionGroup label="Run options" summary="">
          <TaskRow
            label="Dry run (preview only)"
            checked={settings.dryRun}
            onChange={v => setField('dryRun', v)}
          />
          <TaskRow
            label="Keep highest version only"
            checked={settings.keepHighestVersion}
            onChange={v => setField('keepHighestVersion', v)}
          />
          <TaskRow
            label="Preserve folder structure in packages"
            checked={settings.preserveStructure}
            onChange={v => setField('preserveStructure', v)}
          />
          {/* Off by default and not sticky in spirit: it exists for the one run where a large
              cleanup is genuinely correct. See services/guardrail.ts. */}
          <TaskRow
            label="Allow large deletions (override safety check)"
            checked={settings.allowLargeDeletions}
            onChange={v => setField('allowLargeDeletions', v)}
          />
        </AccordionGroup>
      </div>

      {/* Pinned run controls */}
      <div className={css.runControls}>
        <div className={css.runStatus}>
          <div className={`${css.runStatusDot} ${runStatus !== 'idle' ? css[runStatus] : ''}`} />
          <span>
            {runStatus === 'idle'      && 'Idle · ready'}
            {runStatus === 'running'   && 'Running…'}
            {runStatus === 'stopping'  && 'Stopping…'}
            {runStatus === 'completed' && 'Completed'}
            {runStatus === 'error'     && 'Error'}
          </span>
        </div>
        <div className={css.progressBar}>
          <div className={css.progressFill} style={{ width: `${progress}%` }} />
        </div>
        <button className={css.btnRun} onClick={handleRun} disabled={!canRun}>
          {isRunning ? 'Running…' : 'Run'}
        </button>
        <div className={css.runSecondaryRow}>
          <button
            className={`${css.btnSecondary} ${css.btnStop}`}
            onClick={stopRun}
            disabled={!isRunning}
          >
            Stop
          </button>
        </div>
      </div>
    </div>
  );
}
