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
import { runPipeline, scanVersionMap, type RunContext } from '../../services/pipelineService';
import type { CloudUrlEntry } from '../../services/pipelineService';
import { exportAssetsToSupabase, syncVersionHistory, syncTagsFromVocabulary, fetchClientInventory, requestR2Grant } from '../../services/supabaseService';
import { deleteCdnObjects } from '../../services/pipelineService';
import { saveClients, pushCloudDestinations } from '../../services/clientService';
import { notifyRunComplete } from '../../services/notifyService';
import { groupAssets } from '../../domain/assetGrouping';
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

/* ── Run summary ─────────────────────────────────────────────────────────── */
/* Surfaces the per-section "DONE" totals that otherwise only exist as text
   buried in the scrolling activity log (e.g. "CDN DONE — N uploaded · M
   cached · ..."), so they're visible without scrolling through hundreds of
   individual file lines to find them. */
function RunSummarySection() {
  const stats = usePipelineStore(s => s.stats);
  const supabaseSync = usePipelineStore(s => s.supabaseSync);
  const runStatus = usePipelineStore(s => s.runStatus);

  const rows: Array<{ label: string; value: string }> = [];

  if (stats.thumbnails > 0) {
    rows.push({ label: 'Thumbnails', value: `${stats.thumbnails} created` });
  }
  if (stats.cdnThumbUploaded || stats.cdnThumbCached || stats.cdnThumbUnchanged) {
    rows.push({
      label: 'CDN thumbnails',
      value: `${stats.cdnThumbUploaded} uploaded · ${stats.cdnThumbCached} cached · ${stats.cdnThumbUnchanged} unchanged`,
    });
  }
  if (stats.cdnOrigUploaded || stats.cdnOrigCached || stats.cdnOrigUnchanged) {
    rows.push({
      label: 'CDN originals',
      value: `${stats.cdnOrigUploaded} uploaded · ${stats.cdnOrigCached} cached · ${stats.cdnOrigUnchanged} unchanged`,
    });
  }
  if (stats.copied || stats.skipped) {
    rows.push({ label: 'Distribute', value: `${stats.copied} copied · ${stats.skipped} skipped` });
  }
  if (stats.published || stats.pubFolders) {
    rows.push({ label: 'Publish', value: `${stats.published} files · ${stats.pubFolders} folders · ${stats.disconnected} disconnected` });
  }
  if (supabaseSync) {
    rows.push({
      label: 'Supabase',
      value: `${supabaseSync.created} new · ${supabaseSync.updated} updated · ${supabaseSync.disconnected} disconnected`,
    });
    if (supabaseSync.deleted || supabaseSync.errors) {
      rows.push({ label: '', value: `${supabaseSync.deleted} deleted · ${supabaseSync.errors} errors` });
    }
  }
  if (stats.errors > 0) {
    rows.push({ label: 'Errors', value: `${stats.errors} total` });
  }

  const isIdle = runStatus === 'idle' && rows.length === 0;

  return (
    <div className={css.summarySection}>
      <div className={css.issuesPanelHeader}>
        <span className={css.issuesPanelTitle}>Run summary</span>
      </div>
      <div className={css.summaryRows}>
        {isIdle ? (
          <div className={css.issuesEmpty}>Run the pipeline to see a summary here.</div>
        ) : rows.length === 0 ? (
          <div className={css.issuesEmpty}>Nothing to report for this run.</div>
        ) : (
          rows.map((r, i) => (
            <div key={i} className={css.summaryRow}>
              <span className={css.summaryLabel}>{r.label}</span>
              <span className={css.summaryValue}>{r.value}</span>
            </div>
          ))
        )}
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

function IssuesSection() {
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
    <>
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
    </>
  );
}

function RightColumn() {
  return (
    <aside className={css.issuesPanel}>
      <RunSummarySection />
      <IssuesSection />
    </aside>
  );
}

/* ── Config sidebar ─────────────────────────────────────────────────────── */
function ConfigSidebar() {
  const { settings, setField } = useSettingsStore();
  const { runStatus, progress, startRun, stopRun, appendLog, addIssue, finishRun, setProgress, setSupabaseSync } = usePipelineStore();
  const vocab        = useVocabularyStore(s => s.data);
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
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    if (activeClient) {
      const updatedDestinations = activeClient.cloudDestinations.map(d =>
        d.id === id ? { ...d, enabled: nowEnabled } : d
      );
      updateClient(activeClient.id, { cloudDestinations: updatedDestinations });
      saveClients({ clients: useClientStore.getState().clients, activeClientId: activeClient.id }).catch(console.error);
      pushCloudDestinations({ ...activeClient, cloudDestinations: updatedDestinations }).catch(console.error);
    }
  }

  const selectedDests = destinations.filter(d => selectedDestIds.has(d.id));

  const isRunning  = runStatus === 'running';
  const isStopping = runStatus === 'stopping';

  const pathsSet = [settings.sourceFolder, settings.vaultFolder].filter(Boolean).length;

  const tasksOn = [
    settings.doThumbnails, settings.doCdnOriginals, settings.doDistribute, settings.doPublish, settings.doFlatExport, settings.doObsidian,
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
    const cdnUrls      = new Map<string, string>();
    const originalUrls = new Map<string, string>();
    const cloudUrls    = new Map<string, CloudUrlEntry[]>();
    // Cloud destinations for cloud export (selected non-local destinations)
    const cloudDests = selectedDests.filter(d => d.config.type !== 'local');

    // ── Pre-run: storage grant + CDN inventory ───────────────────────────────
    // The client IS a DB row now — its id is the identity, no name resolution.
    // Sync runs as the signed-in user (RLS staff policies); no service key.
    // CDN uploads run on a short-lived, client-scoped storage grant from the
    // r2-grant Control API — no permanent R2 credentials exist on this machine.
    const sbEnabled = !!(activeClient?.supabaseUrl && activeClient?.supabaseAnonKey);
    const sbConfig = sbEnabled ? {
      url:     activeClient!.supabaseUrl!,
      anonKey: activeClient!.supabaseAnonKey!,
    } : null;
    const clientId: string | null = sbConfig ? activeClient!.id : null;
    const log = appendLog as (type: string, msg: string) => void;

    let r2Config: RunContext['r2'];
    if (sbConfig && clientId && (settings.doThumbnails || settings.doCdnOriginals)) {
      try {
        const grant = await requestR2Grant(sbConfig, clientId);
        r2Config = {
          endpoint:     grant.endpoint,
          accessKeyId:  grant.accessKeyId,
          secretKey:    grant.secretAccessKey,
          sessionToken: grant.sessionToken,
          bucket:       grant.bucket,
          publicDomain: grant.publicDomain,
        };
        log('dim', `  Storage grant issued for "${activeClient!.name}" (bucket ${grant.bucket}, expires ${new Date(grant.expiresAt).toLocaleTimeString()})`);
      } catch (e) {
        log('error', `  ✕  CDN steps disabled — ${e}`);
      }
    }

    if (sbConfig) {
      if (clientId && r2Config) {
        // Pre-populate cdnUrls from DB so runCdnUpload skips already-uploaded assets
        try {
          const inventory = await fetchClientInventory(clientId, sbConfig);
          const withUrl   = inventory.filter(r => r.thumbnail_url);
          for (const rec of withUrl) {
            // Gallery children use shortcodes with '|' — skip pre-populating so the CDN upload
            // step always attempts to verify/re-upload them (guards against stale deletions).
            if (rec.shortcode.includes('|')) continue;
            // URL is .../thumbnails/{stem}-thumb.webp — extract stem to match runCdnUpload lookup key.
            // Only add the stem key if the extracted stem belongs to this asset (not a gallery parent
            // whose thumbnail_url points to a child's stem — that would wrongly skip the child upload).
            const m = rec.thumbnail_url!.match(/thumbnails\/(.+)-thumb\.webp$/);
            if (m) {
              const urlStem     = decodeURIComponent(m[1]);
              const urlShortcode = urlStem.replace(/\s+[vV]\d+(?:[-._]\d+)*\s*$/, '').trim();
              if (urlShortcode === rec.shortcode) {
                // Stem belongs to this asset — safe to skip CDN re-upload
                cdnUrls.set(urlStem, rec.thumbnail_url!);
              }
              // If they differ (gallery parent whose thumbnail = first child's URL), don't cache the
              // child stem — the CDN step will re-upload the child thumbnail as needed.
            }
            // Always key by shortcode so other versions of the same asset are also skipped
            cdnUrls.set(rec.shortcode, rec.thumbnail_url!);
          }
          const noUrl = inventory.length - withUrl.length;
          const noMatch = withUrl.filter(r => !r.thumbnail_url!.match(/thumbnails\/(.+)-thumb\.webp$/)).length;
          appendLog('dim', `  CDN inventory: ${inventory.length} records · ${withUrl.length} with URL · ${noUrl} null · ${noMatch} regex miss`);
          if (withUrl.length > 0) appendLog('dim', `  Sample URL: ${withUrl[0].thumbnail_url}`);
        } catch (e) {
          appendLog('dim', `  CDN inventory fetch skipped: ${e}`);
        }
      }
    }

    // ── Pipeline (thumbnails + CDN upload skips known assets) ─────────────────
    const stats = await runPipeline({
      settings: effectiveSettings,
      vocab:    vocabData,
      appendLog, addIssue, setProgress, finishRun,
      collectedAssets,
      cdnUrls,
      originalUrls,
      cloudUrls,
      cloudDestinations: cloudDests,
      r2: r2Config,
      identityMigrated: !!activeClient?.identityMigrated,
    });

    // ── Post-run: Supabase sync + targeted CDN cleanup ────────────────────────
    if (sbConfig && clientId) {
      const { singles, galleries, packageDirs, filePaths } = groupAssets(collectedAssets, effectiveSettings.outFolder ?? 'OUT');

      if (!singles.length && !galleries.length) {
        appendLog('info', 'Supabase: no assets found in source — skipping export.');
      } else {
        const identity = { migrated: !!activeClient?.identityMigrated, packageDirs, filePaths };
        const sbResult = await exportAssetsToSupabase(singles, clientId, vocabData, sbConfig, log, cdnUrls, cloudUrls, galleries, identity, originalUrls);
        setSupabaseSync({
          created:      sbResult.created,
          updated:      sbResult.updated,
          disconnected: sbResult.disconnected,
          deleted:      sbResult.deleted,
          errors:       sbResult.errors,
        });

        // Delete stale CDN objects identified by Supabase diff (no R2 listing needed)
        if (r2Config && sbResult.staleObjectKeys.length > 0) {
          await deleteCdnObjects(r2Config, sbResult.staleObjectKeys, log);
        }

        // Sync vocabulary tag groups so the web portal can show collapsible subcategories
        await syncTagsFromVocabulary(vocabData, clientId, sbConfig, log);
      }

      if (effectiveSettings.sourceFolder) {
        const versionMap = await scanVersionMap(effectiveSettings.sourceFolder, vocabData, effectiveSettings);
        await syncVersionHistory(versionMap, clientId, vocabData, sbConfig, log);
      }
    }

    notifyRunComplete(stats, stats.errors > 0 || stats.skipped > 0);
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
      <RightColumn />
    </div>
  );
}
