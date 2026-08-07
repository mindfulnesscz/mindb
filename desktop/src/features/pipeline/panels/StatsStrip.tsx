/* The nine counters across the top of the activity area. */

import { usePipelineStore } from '../../../store/pipelineStore';
import css from '../PipelineView.module.css';

export function StatsStrip() {
  // Per-field selectors: a whole-store subscription re-rendered this strip on every
  // buffered log flush, which is ten times a second during a run and says nothing new.
  const stats        = usePipelineStore(s => s.stats);
  const lastRunLabel = usePipelineStore(s => s.lastRunLabel);
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
