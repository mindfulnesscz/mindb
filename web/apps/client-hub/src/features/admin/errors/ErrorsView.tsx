/* The error log, for the people who maintain the app.
 *
 * Grouped by (context, message), because the raw table is mostly repetition — one broken screen writes
 * the same row hundreds of times, and a list of individual reports buries the second problem under the
 * first. The detail is one click away when it is actually wanted.
 *
 * The `context` prefix is the point: it says whether the flaw is in auth, syncing or display before
 * anyone reads a stack.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  fetchErrorGroups, fetchErrorDetail, fetchNotifications,
  type ErrorGroup, type ErrorWindow, type AppError, type ErrorNotification,
} from '../../../services/errorService'
import { reportError, toMessage } from '../../../lib/reportError'
import { NotificationSettings } from './NotificationSettings'

const WINDOWS: ErrorWindow[] = ['24 hours', '7 days', '30 days']

export function ErrorsView({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const [groups, setGroups] = useState<ErrorGroup[]>([])
  const [notifications, setNotifications] = useState<ErrorNotification[]>([])
  const [window_, setWindow] = useState<ErrorWindow>('24 hours')
  const [open, setOpen] = useState<string | null>(null)
  const [detail, setDetail] = useState<AppError[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [g, n] = await Promise.all([fetchErrorGroups(window_), fetchNotifications()])
      setGroups(g)
      setNotifications(n)
    } catch (e) {
      setError(toMessage(e))
      reportError('config.ErrorsView.load', e)
    } finally {
      setLoading(false)
    }
  }, [window_])

  useEffect(() => { if (isSuperAdmin) void load() }, [isSuperAdmin, load])

  // Said plainly rather than shown as an empty table: "no errors" and "not yours to see" must not look
  // identical.
  if (!isSuperAdmin) {
    return (
      <p className="text-sm font-sans text-text-muted">
        Errors are visible to super admins — they carry client asset names and file paths.
      </p>
    )
  }

  async function toggle(g: ErrorGroup) {
    const key = `${g.context} ${g.message}`
    if (open === key) { setOpen(null); return }
    setOpen(key)
    try {
      setDetail(await fetchErrorDetail(g.context, g.message))
    } catch (e) {
      reportError('config.ErrorsView.detail', e)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-sans font-bold uppercase tracking-label text-text-muted">
          Errors
        </h3>
        <div className="flex items-center gap-2">
          {WINDOWS.map(w => (
            <button
              key={w}
              type="button"
              onClick={() => setWindow(w)}
              className={`text-[11px] font-sans ${w === window_ ? 'font-bold text-cosmos-black' : 'text-text-muted hover:text-cosmos-black'}`}
            >
              {w}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => void load()} className="text-[11px] font-sans text-text-muted hover:text-cosmos-black">
          Refresh
        </button>
      </div>

      {error && <p className="text-sm font-sans text-signal-error">{error}</p>}
      {loading && <p className="text-sm font-sans text-text-muted">Loading…</p>}

      {!loading && groups.length === 0 && (
        <p className="text-[11px] font-sans text-text-subtle border border-border rounded-sm px-3 py-4">
          No errors reported in the last {window_}.
        </p>
      )}

      {groups.length > 0 && (
        <div className="border border-border rounded-sm overflow-hidden">
          <table className="w-full text-sm font-sans">
            <thead className="text-[10px] uppercase tracking-label text-text-muted">
              <tr>
                <th className="text-left px-3 py-1.5 font-normal w-40">Concern</th>
                <th className="text-left px-3 py-1.5 font-normal">Message</th>
                <th className="text-left px-3 py-1.5 font-normal w-20">Count</th>
                <th className="text-left px-3 py-1.5 font-normal w-40">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(g => {
                const key = `${g.context} ${g.message}`
                return (
                  <tr
                    key={key}
                    onClick={() => void toggle(g)}
                    className="border-t border-border cursor-pointer hover:bg-surface-sunken align-top"
                  >
                    <td className="px-3 py-2 font-mono text-[11px]">
                      {/* The prefix answers "where are the flaws" without opening anything. */}
                      <span className="font-bold">{g.context.split('.')[0]}</span>
                      <span className="text-text-subtle">.{g.context.split('.').slice(1).join('.')}</span>
                    </td>
                    <td className="px-3 py-2">
                      {g.isNew && (
                        <span className="mr-2 text-[10px] font-bold uppercase tracking-label text-signal-error">new</span>
                      )}
                      {g.message}
                      {open === key && detail.length > 0 && (
                        <div className="mt-2 space-y-2">
                          {detail.slice(0, 3).map(d => (
                            <div key={d.id} className="border border-border rounded-sm p-2 bg-bg">
                              <div className="text-[10px] font-mono text-text-subtle">
                                {d.source} · {d.app_version ?? 'unknown build'} · {d.environment ?? '—'}
                              </div>
                              {d.breadcrumbs.length > 0 && (
                                <div className="text-[11px] font-mono text-text-muted mt-1">
                                  after: {d.breadcrumbs.join(' → ')}
                                </div>
                              )}
                              {d.stack && (
                                <pre className="mt-1 text-[10px] font-mono overflow-x-auto whitespace-pre-wrap">{d.stack}</pre>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">{g.occurrences}</td>
                    <td className="px-3 py-2 text-[11px] text-text-muted">
                      {new Date(g.lastSeen).toLocaleString()}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <NotificationSettings notifications={notifications} onChanged={() => void load()} />
    </div>
  )
}
