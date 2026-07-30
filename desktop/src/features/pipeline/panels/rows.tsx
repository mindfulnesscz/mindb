/* The two row shapes the sidebar repeats: a task checkbox, and a destination checkbox.
 *
 * A destination row carries its token freshness as a dot, because an expired token is the most
 * common reason a cloud export fails — and it is invisible until the run reaches that stage.
 */

import { tokenStatus, cloudToken } from '../../../domain/client';
import type { CloudDestination, LocalDestConfig } from '../../../domain/client';

export function TaskRow({
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

export function DestRow({
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
