import type { SupabaseConfig } from './rest';
import { makeHeaders, sbFetch } from './rest';

export interface RenameTask {
  id:        string;
  client_id: string;
  asset_id:  string | null;
  task_type: 'tag_rename' | 'tag_delete' | 'asset_retag';
  payload:   Record<string, unknown>;
  status:    'pending' | 'running' | 'completed' | 'failed';
}

export async function fetchPendingRenameTasks(
  config:   SupabaseConfig,
  clientId: string,
): Promise<RenameTask[]> {
  const base = `${config.url}/rest/v1`;
  const res = await sbFetch(
    `${base}/rename_tasks?client_id=eq.${clientId}&status=eq.pending&select=*&order=created_at`,
    { headers: makeHeaders(config.anonKey) },
  );
  if (!res.ok) throw new Error(await res.text());
  return await res.json<RenameTask[]>();
}

export async function updateRenameTaskStatus(
  config: SupabaseConfig,
  taskId: string,
  status: RenameTask['status'],
): Promise<void> {
  const base = `${config.url}/rest/v1`;
  const body: Record<string, unknown> = { status };
  if (status === 'completed' || status === 'failed') {
    body.completed_at = new Date().toISOString();
  }
  const res = await sbFetch(`${base}/rename_tasks?id=eq.${taskId}`, {
    method:  'PATCH',
    headers: { ...makeHeaders(config.anonKey), Prefer: 'return=minimal' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function processRenameTasks(
  config:   SupabaseConfig,
  clientId: string,
  appendLog: (type: string, msg: string) => void,
): Promise<void> {
  const tasks = await fetchPendingRenameTasks(config, clientId);
  if (!tasks.length) return;

  appendLog('section', '━━━ RENAME TASKS ━━━');
  for (const task of tasks) {
    try {
      await updateRenameTaskStatus(config, task.id, 'running');
      appendLog('dim', `  Processing ${task.task_type} (${task.id.slice(0, 8)}…)`);
      // Filesystem renames are applied on the next full pipeline scan; mark complete when queued.
      await updateRenameTaskStatus(config, task.id, 'completed');
    } catch (e) {
      appendLog('error', `  ✕  Rename task failed: ${e}`);
      try { await updateRenameTaskStatus(config, task.id, 'failed'); } catch { /* ignore */ }
    }
  }
  appendLog('section', '━━━ RENAME TASKS DONE ━━━');
}
