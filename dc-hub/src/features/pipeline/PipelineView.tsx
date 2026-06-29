import { useRef, useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { AccordionGroup } from './AccordionGroup';
import { FolderPicker } from './FolderPicker';
import { useSettingsStore } from '../../store/settingsStore';
import { usePipelineStore } from '../../store/pipelineStore';
import { runPipeline } from '../../services/pipelineService';
import css from './PipelineView.module.css';

/* ── Log type glyphs ──────────────────────────────────────────────────────── */
const LOG_MARKERS: Record<string, string> = {
  section:      '▶',
  info:         '·',
  success:      '✓',
  skip:         '⚡',
  error:        '✕',
  dim:          '·',
  disconnected: '⦾',
};

/* ── Stats strip ─────────────────────────────────────────────────────────── */
function StatsStrip() {
  const { stats, lastRunLabel } = usePipelineStore();
  const cells = [
    { label: 'Packages',    value: stats.packages },
    { label: 'Copied',      value: stats.copied },
    { label: 'Skipped',     value: stats.skipped },
    { label: 'Errors',      value: stats.errors },
    { label: 'Pub. Folders',value: stats.pubFolders },
    { label: 'Published',   value: stats.published },
    { label: 'Thumbnails',  value: stats.thumbnails },
    { label: 'Notes',       value: stats.notes },
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

  const isRunning  = runStatus === 'running';
  const isStopping = runStatus === 'stopping';

  const pathsSet = [
    settings.sourceFolder,
    settings.targetFolder,
    settings.onedriveFlatFolder,
    settings.vaultFolder,
  ].filter(Boolean).length;

  const tasksOn = [
    settings.doThumbnails, settings.doDistribute, settings.doPublish,
    settings.doFlatExport, settings.doObsidian,
  ].filter(Boolean).length;

  const canRun = !isRunning && !isStopping && tasksOn > 0 && !!settings.sourceFolder;

  async function handleRun() {
    startRun();
    await runPipeline({ settings, appendLog, addIssue, setProgress, finishRun });
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
            onChange={v => setField('sourceFolder', v)}
          />
          <FolderPicker
            label="Target folder"
            value={settings.targetFolder}
            onChange={v => setField('targetFolder', v)}
          />
          <FolderPicker
            label="OneDrive flat folder"
            value={settings.onedriveFlatFolder}
            onChange={v => setField('onedriveFlatFolder', v)}
          />
          <FolderPicker
            label="Obsidian vault"
            value={settings.vaultFolder}
            onChange={v => setField('vaultFolder', v)}
          />
        </AccordionGroup>

        {/* Connections */}
        <AccordionGroup label="Connections" summary="Manual auth">
          <CloudConnection name="Dropbox" connected={!!settings.dropboxToken} />
          <CloudConnection name="OneDrive" connected={!!settings.onedriveToken} />
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
            label="3  Publish on cloud"
            checked={settings.doPublish}
            onChange={v => setField('doPublish', v)}
          />
          <TaskRow
            label="Flat export to OneDrive"
            checked={settings.doFlatExport}
            onChange={v => setField('doFlatExport', v)}
            indent
          />
          <TaskRow
            label="4  Publish to DAM"
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
          <button
            className={css.btnSecondary}
            disabled={isRunning || isStopping}
          >
            Update OneDrive links
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

function CloudConnection({ name, connected }: { name: string; connected: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{
        width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
        background: connected ? 'var(--signal-success)' : 'var(--gray-300)',
      }} />
      <span style={{ flex: 1, fontSize: 'var(--text-sm)', fontWeight: 500 }}>{name}</span>
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
        {connected ? 'Connected' : 'Not connected'}
      </span>
      <button style={{
        padding: '3px 8px', fontSize: 'var(--text-xs)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)', background: 'transparent', cursor: 'pointer',
        fontFamily: 'var(--font-sans)', color: 'var(--text)',
      }}>
        {connected ? 'Reconnect' : 'Connect'}
      </button>
    </div>
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
