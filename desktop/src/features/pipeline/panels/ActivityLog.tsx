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

export function ActivityLog() {
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
