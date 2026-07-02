import { useRef, useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { AccordionGroup } from './AccordionGroup';
import { FolderPicker } from './FolderPicker';
import { useSettingsStore } from '../../store/settingsStore';
import { usePipelineStore } from '../../store/pipelineStore';
import { useVocabularyStore } from '../../store/vocabularyStore';
import { useClientStore } from '../../store/clientStore';
import { tokenStatus, cloudToken } from '../../domain/client';
import type { CloudDestination, LocalDestConfig } from '../../domain/client';
import { runPipeline, scanVersionMap } from '../../services/pipelineService';
import type { CloudUrlEntry } from '../../services/pipelineService';
import { exportAssetsToSupabase, syncVersionHistory, resolveClientId } from '../../services/supabaseService';
import { saveClients } from '../../services/clientService';
import css from './PipelineView.module.css';

/* ── Log type glyphs ──────────────────────────────────────────────────────── */
const LOG_MARKERS: Record<string, string> = {
  section:      '▶',
  info:         '·',
  success:      '✓',
  skip:         '⚡',
  warn:         '⚠',
  error:        '✕',
  dim:          '·',
  disconnected: '⦾',
};

/* ── Stats strip ─────────────────────────────────────────────────────────── */
function StatsStrip() {
  const { stats, lastRunLabel } = usePipelineStore();
  const cells = [
    { label: 'Packages',      value: stats.packages },
    { label: 'Copied',        value: stats.copied },
    { label: 'Skipped',       value: stats.skipped },
    { label: 'Errors',        value: stats.errors },
    { label: 'Pub. Folders',  value: stats.pubFolders },
    { label: 'Published',     value: stats.published },
    { label: 'Thumbnails',    value: stats.thumbnails },
    { label: 'Notes',         value: stats.notes },
    { label: 'Disconnected',  value: stats.disconnected },
  ];
  return (
    <div className={css.statsStrip}>
      <div className={css.statsLabel}>
        {lastRunLabel ? `Last run · ${lastRunLabel}` : 'No run yet'}
      </div>
      <div className={css.statsGrid}>
        {cells.map(c => (
          <div key={c.label} className={css.statCell}>
            <span className={css.statNumber}>{c.value}</span>
            <span className={css.statLabel}>{c.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Activity log ────────────────────────────────────────────────────────── */
function ActivityLog() {
  const { log, clearLog } = usePipelineStore();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log.length]);

  return (
    <div className={css.logArea}>
      <div className={css.logHeader}>
        <span className={css.logTitle}>Activity log</span>
        <button className={css.btnClear} onClick={clearLog}>Clear</button>
      </div>
      <div className={css.logScroll}>
        {log.length === 0 && (
          <div className={css.logEmpty}>Log is empty — run the pipeline to see output.</div>
        )}
        {log.map(line => (
          <div key={line.id} className={css.logLine} data-type={line.type}>
            <span className={css.logTs}>{line.timestamp}</span>
            <span className={css.logMarker}>{LOG_MARKERS[line.type] ?? '·'}</span>
            <span className={css.logMsg}>{line.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

/* ── Issues panel ────────────────────────────────────────────────────────── */
const ISSUE_CATEGORIES = [
  { key: 'skipped' as const,          label: 'Skipped' },
  { key: 'disconnected' as const,     label: 'Disconnected / broken links' },
  { key: 'version-conflict' as const, label: 'Version conflicts' },
  { key: 'error' as const,            label: 'Errors' },
];

function IssuesPanel() {
  const issues = usePipelineStore(s => s.issues);
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    new Set(['skipped', 'disconnected', 'version-conflict', 'error'])
  );

  const total = issues.length;

  function toggleGroup(key: string) {
    setOpenGroups(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  return (
    <aside className={css.issuesPanel}>
      <div className={css.issuesPanelHeader}>
        <span className={css.issuesPanelTitle}>
          Issues{total > 0 ? ` · ${total} to review` : ''}
        </span>
      </div>
      <div className={css.issuesPanelScroll}>
        {total === 0 ? (
          <div className={css.issuesEmpty}>No issues — clean run.</div>
        ) : (
          ISSUE_CATEGORIES.map(cat => {
            const rows = issues.filter(i => i.category === cat.key);
            if (!rows.length) return null;
            const open = openGroups.has(cat.key);
            return (
              <div key={cat.key} className={css.issueGroup}>
                <div
                  className={css.issueGroupHeader}
                  onClick={() => toggleGroup(cat.key)}
                >
                  <ChevronRight
                    size={12}
                    className={`${css.issueGroupCaret}${open ? ` ${css.open}` : ''}`}
                  />
                  <span className={css.issueGroupLabel}>{cat.label}</span>
                  <span className={`${css.issueBadge}${cat.key === 'error' ? ` ${css.error}` : ''}`}>
                    {rows.length}
                  </span>
                </div>
                {open && (
                  <div className={css.issueRows}>
                    {rows.map(issue => (
                      <div key={issue.id} className={css.issueRow}>
                        <span className={css.issueFile}>{issue.file}</span>
                        <span className={css.issueReason}>{issue.reason}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

/* ── Config sidebar ─────────────────────────────────────────────────────── */
function ConfigSidebar() {
  const { settings, setField } = useSettingsStore();
  const { runStatus, progress, startRun, stopRun, appendLog, addIssue, finishRun, setProgress } = usePipelineStore();
  const vocab        = useVocabularyStore(s => s.data);
  const { clients, activeClientId, updateClient } = useClientStore();
  const activeClient = clients.find(c => c.id === activeClientId) ?? null;

  const destinations = activeClient?.cloudDestinations ?? [];

  const [selectedDestIds, setSelectedDestIds] = useState<Set<string>>(
    () => new Set(destinations.map((d: CloudDestination) => d.id))
  );

  useEffect(() => {
    setSelectedDestIds(new Set(
      activeClient?.cloudDestinations.map((d: CloudDestination) => d.id) ?? []
    ));
  }, [activeClient?.id]);

  function toggleDest(id: string) {
    setSelectedDestIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const selectedDests = destinations.filter(d => selectedDestIds.has(d.id));

  const isRunning  = runStatus === 'running';
  const isStopping = runStatus === 'stopping';

  const pathsSet = [settings.sourceFolder, settings.vaultFolder].filter(Boolean).length;

  const tasksOn = [
    settings.doThumbnails, settings.doDistribute, settings.doPublish, settings.doFlatExport, settings.doObsidian,
  ].filter(Boolean).length;

  const destSummary = destinations.length === 0
    ? 'none'
    : selectedDests.length === destinations.length
      ? `all ${destinations.length}`
      : `${selectedDests.length} of ${destinations.length}`;

  const canRun = !isRunning && !isStopping && tasksOn > 0
    && !!settings.sourceFolder && selectedDests.length > 0;

  async function handleRun() {
    startRun();
    const vocabData = vocab ?? { _schema_version: '2.1.0', _comment: '', tags: [] };
    const localDest = selectedDests.find(d => d.config.type === 'local');
    const hasCloudDests = selectedDests.some(d => d.config.type !== 'local');
    const effectiveSettings = {
      ...settings,
      targetFolder: localDest
        ? (localDest.config as LocalDestConfig).path
        : settings.targetFolder,
      // If a local destination is checked, always export — the dest checkbox is the control
      doPublish:    localDest ? true : settings.doPublish,
      // Enable flat export when cloud destinations are selected
      doFlatExport: hasCloudDests ? settings.doFlatExport : false,
    };
    const collectedAssets: string[] = [];
    const cdnUrls   = new Map<string, string>();
    const cloudUrls = new Map<string, CloudUrlEntry[]>();
    const r2Config = (
      activeClient?.r2Endpoint &&
      activeClient?.r2AccessKeyId &&
      activeClient?.r2SecretKey &&
      activeClient?.r2Bucket &&
      activeClient?.r2PublicDomain
    ) ? {
      endpoint:     activeClient.r2Endpoint,
      accessKeyId:  activeClient.r2AccessKeyId,
      secretKey:    activeClient.r2SecretKey,
      bucket:       activeClient.r2Bucket,
      publicDomain: activeClient.r2PublicDomain,
    } : undefined;

    // Cloud destinations for cloud export (selected non-local destinations)
    const cloudDests = selectedDests.filter(d => d.config.type !== 'local');

    await runPipeline({
      settings: effectiveSettings,
      vocab:    vocabData,
      appendLog, addIssue, setProgress, finishRun,
      collectedAssets,
      cdnUrls,
      cloudUrls,
      cloudDestinations: cloudDests,
      r2: r2Config,
    });
    if (activeClient?.supabaseUrl && activeClient?.supabaseServiceKey) {
      const sbConfig = {
        url:        activeClient.supabaseUrl,
        serviceKey: activeClient.supabaseServiceKey,
      };
      const log      = appendLog as (type: string, msg: string) => void;
      const clientId = await resolveClientId(activeClient.name, activeClient.brandColor, sbConfig, log);

      if (clientId) {
        const assetStems = collectedAssets.map(f => {
          const name = f.split('/').pop()!;
          const dot  = name.lastIndexOf('.');
          return dot > 0 ? name.slice(0, dot) : name;
        });

        if (!assetStems.length) {
          appendLog('info', 'Supabase: no assets found in source — skipping export.');
        } else {
          await exportAssetsToSupabase(assetStems, clientId, vocabData, sbConfig, log, cdnUrls, cloudUrls);
        }

        if (effectiveSettings.sourceFolder) {
          const versionMap = await scanVersionMap(effectiveSettings.sourceFolder, vocabData, effectiveSettings);
          await syncVersionHistory(versionMap, clientId, vocabData, sbConfig, log);
        }
      }
    }
  }

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
                saveClients({ clients: useClientStore.getState().clients, activeClientId }).catch(console.error);
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
                saveClients({ clients: useClientStore.getState().clients, activeClientId }).catch(console.error);
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
            label="2  Distribute packages"
            checked={settings.doDistribute}
            onChange={v => setField('doDistribute', v)}
          />
          <TaskRow
            label="3  Export to destinations"
            checked={settings.doPublish}
            onChange={v => setField('doPublish', v)}
          />
          <TaskRow
            label="4  Cloud export"
            checked={settings.doFlatExport}
            onChange={v => setField('doFlatExport', v)}
          />
          <TaskRow
            label="5  Publish to DAM"
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

function TaskRow({
  label, checked, onChange, indent = false,
}: { label: string; checked: boolean; onChange: (v: boolean) => void; indent?: boolean }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: indent ? 16 : 0, cursor: 'pointer' }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        style={{ width: 14, height: 14, accentColor: 'var(--cosmos-black)' }}
      />
      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text)', fontWeight: 500 }}>
        {label}
      </span>
    </label>
  );
}

const DEST_TYPE_LABELS: Record<string, string> = {
  local: 'Local', dropbox: 'Dropbox', onedrive: 'OneDrive', gdrive: 'Drive',
};
const DEST_TYPE_COLORS: Record<string, { bg: string; color: string }> = {
  local:    { bg: 'var(--gray-150)',  color: 'var(--text-muted)' },
  dropbox:  { bg: '#dbeafe',          color: '#1d4ed8' },
  onedrive: { bg: '#ddf4ff',          color: '#0077c8' },
  gdrive:   { bg: '#fef9c3',          color: '#854d0e' },
};
const STATUS_COLORS: Record<string, string> = {
  none: 'var(--gray-300)', fresh: '#4ade80', expiring: '#facc15', expired: 'var(--signal-error)',
};

function DestRow({
  dest, checked, onChange,
}: { dest: CloudDestination; checked: boolean; onChange: () => void }) {
  const token  = cloudToken(dest.config);
  const status = tokenStatus(token);
  const tc     = DEST_TYPE_COLORS[dest.config.type] ?? DEST_TYPE_COLORS.local;
  const rawPath = dest.config.type === 'local'
    ? (dest.config as LocalDestConfig).path
    : (dest.config as { remotePath: string }).remotePath ?? '';
  const shortPath = rawPath ? rawPath.split(/[/\\]/).slice(-2).join('/') : '';

  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', minWidth: 0 }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        style={{ width: 14, height: 14, accentColor: 'var(--cosmos-black)', flexShrink: 0 }}
      />
      <span style={{
        fontSize: '10px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
        padding: '2px 6px', borderRadius: 'var(--radius-pill)', flexShrink: 0,
        background: tc.bg, color: tc.color,
      }}>
        {DEST_TYPE_LABELS[dest.config.type]}
      </span>
      <span style={{ flex: 1, fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {dest.name}
      </span>
      {shortPath && (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-subtle)', flexShrink: 0 }}>
          {shortPath}
        </span>
      )}
      {dest.config.type !== 'local' && (
        <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: STATUS_COLORS[status] }} />
      )}
    </label>
  );
}

/* ── Root layout ─────────────────────────────────────────────────────────── */
export function PipelineView() {
  return (
    <div className={css.root}>
      <ConfigSidebar />
      <div className={css.activityArea}>
        <StatsStrip />
        <ActivityLog />
      </div>
      <IssuesPanel />
    </div>
  );
}
