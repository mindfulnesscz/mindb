/* The pipeline screen — three columns.
 *
 *   ConfigSidebar   paths, destinations, tasks, the Run button
 *   activity area   the stats strip and the live log
 *   IssuesPanel     the run summary, and what needs a human
 *
 * The run logic that used to sit in this file is now ./runPlan.ts (what the checkboxes MEAN, pure and
 * tested) and ./useRunPipeline.ts (the orchestration around runPipeline).
 */

import { ConfigSidebar } from './panels/ConfigSidebar';
import { StatsStrip } from './panels/StatsStrip';
import { ActivityLog } from './panels/ActivityLog';
import { IssuesPanel } from './panels/IssuesPanel';
import css from './PipelineView.module.css';

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
