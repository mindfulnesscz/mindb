/* The destination list — one row per destination, with its token freshness as a dot.
 *
 * Structure (name, remote path, role, package export) is read-only here: the portal owns it, and Sync
 * pulls it. Only the local path and the OAuth tokens are this machine's to set.
 */

import { Pencil, RefreshCcw } from 'lucide-react';
import { tokenStatus, cloudToken } from '../../../domain/client';
import type { CloudDestination } from '../../../domain/client';
import { typeLabel, typeClass, statusClass, statusTitle, layoutLabel } from '../destLabels';
import css from '../CloudDestinations.module.css';

export function DestList({
  dests, clientName, syncing, syncMsg, onSync, onEdit,
}: {
  dests: CloudDestination[];
  clientName: string;
  syncing: boolean;
  syncMsg: string;
  onSync: () => void;
  onEdit: (d: CloudDestination) => void;
}) {
  return (
    <>
      <div className={css.listHeader}>
        <span className={css.listTitle}>
          Cloud destinations
          {clientName && <span className={css.clientLabel}>— {clientName}</span>}
        </span>
        <button className={css.outlineBtn} onClick={onSync} disabled={syncing} title="Pull from portal">
          <RefreshCcw size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} />
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
      </div>

      <p className={css.empty} style={{ marginBottom: 'var(--sp-3)' }}>
        Structure (name, remote paths, roles, package export) is managed in the web portal.
        Set local folder paths and connect OAuth here — tokens are stored in the OS keychain.
      </p>
      {syncMsg && <p className={css.empty} style={{ marginTop: 0 }}>{syncMsg}</p>}

      {dests.length === 0
        ? <p className={css.empty}>No destinations yet. Add them in the portal Admin drawer, then Sync.</p>
        : (
          <div className={css.destList}>
            {dests.map(dest => {
              const token  = cloudToken(dest.config);
              const status = dest.config.type === 'local' ? 'none' : tokenStatus(token);
              const path   = dest.config.type === 'local'
                ? dest.config.path
                : dest.config.remotePath;
              return (
                <div key={dest.id} className={css.destRow}>
                  <span className={`${css.destTypeTag} ${typeClass(dest.config.type)}`}>
                    {typeLabel(dest.config.type)}
                  </span>
                  <span className={css.destName}>{dest.name || 'Unnamed'}</span>
                  <span className={css.destPath}>
                    {path || (dest.config.type === 'local' ? 'Set path…' : '—')}
                    {` · ${layoutLabel(dest)}`}
                  </span>
                  <span className={css.roleBadge}>{dest.role}</span>
                  <span className={`${css.statusDot} ${statusClass(status)}`} title={statusTitle(status, token)} />
                  <div className={css.rowActions}>
                    <button className={css.iconBtn} onClick={() => onEdit(dest)} title="Connect / credentials">
                      <Pencil size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )
      }
    </>
  );
}
