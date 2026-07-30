/* The right column: what the run did, and what needs a human.
 *
 * Issues are grouped by category and collapsible, because a run over a few hundred assets can raise
 * dozens of skips while carrying one error that matters.
 */

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { usePipelineStore } from '../../../store/pipelineStore';
import { buildSummaryRows } from '../summaryRows';
import css from '../PipelineView.module.css';

function RunSummarySection() {
  const stats        = usePipelineStore(s => s.stats);
  const supabaseSync = usePipelineStore(s => s.supabaseSync);
  const runStatus    = usePipelineStore(s => s.runStatus);

  const rows   = buildSummaryRows(stats, supabaseSync);
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
      if (next.has(key)) next.delete(key);
      else next.add(key);
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

export function IssuesPanel() {
  return (
    <aside className={css.issuesPanel}>
      <RunSummarySection />
      <IssuesSection />
    </aside>
  );
}
