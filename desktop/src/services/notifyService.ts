import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import type { RunStats } from '../store/pipelineStore';

export async function notifyRunComplete(stats: RunStats, hasIssues: boolean) {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === 'granted';
  if (!granted) return;

  const body = hasIssues
    ? `Finished with issues — ${stats.copied} copied · ${stats.errors} error(s) · ${stats.skipped} skipped`
    : `${stats.copied} copied · ${stats.published} published · ${stats.thumbnails} thumbnail(s)`;

  sendNotification({ title: hasIssues ? 'DC Hub — run finished with issues' : 'DC Hub — run complete', body });
}
