/* The scrolling run log, pinned to its own bottom as lines arrive. */

import { useRef, useEffect } from 'react';
import { usePipelineStore } from '../../../store/pipelineStore';
import css from '../PipelineView.module.css';

/* Log type glyphs. */
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

/* How many lines are actually rendered. A run over a large library emits one line per file per
   stage — tens of thousands of them — and mapping the whole array puts every one of those in the
   DOM, where each store flush re-reconciles all of them. The store still HOLDS every line (the
   panel is a tail, not the record), and the ones off the top are counted rather than silently
   dropped. Raise this and the log panel becomes the slowest thing in the run again. */
const MAX_RENDERED_LINES = 1500;

export function ActivityLog() {
  const log = usePipelineStore(s => s.log);
  const clearLog = usePipelineStore(s => s.clearLog);
  const bottomRef = useRef<HTMLDivElement>(null);

  const hidden  = Math.max(0, log.length - MAX_RENDERED_LINES);
  const visible = hidden ? log.slice(hidden) : log;

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
        {hidden > 0 && (
          <div className={css.logLine} data-type="dim">
            <span className={css.logMsg}>
              … {hidden.toLocaleString()} earlier line{hidden === 1 ? '' : 's'} not shown
            </span>
          </div>
        )}
        {visible.map(line => (
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
