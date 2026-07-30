/* Where digests go. Slack incoming webhooks, one per channel.
 *
 * A stored URL is never shown in full — it is the credential that authorises posting to that channel,
 * and this screen is read over shoulders and screen-shared. Masking it costs nothing and means a
 * leaked screenshot is not a leaked channel.
 */

import { useState } from 'react'
import {
  addNotification, removeNotification, setNotificationEnabled, maskWebhook,
  type ErrorNotification,
} from '../../../services/errorService'
import { reportError, toMessage } from '../../../lib/reportError'

export function NotificationSettings({
  notifications, onChanged,
}: {
  notifications: ErrorNotification[]
  onChanged: () => void
}) {
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [notifyAll, setNotifyAll] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function run(action: () => Promise<void>, context: string) {
    setBusy(true); setError('')
    try {
      await action()
      onChanged()
    } catch (e) {
      setError(toMessage(e))
      reportError(context, e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border border-border rounded-sm">
      <div className="px-3 py-2 bg-surface-sunken border-b border-border text-[10px] font-sans uppercase tracking-label text-text-muted">
        Slack digests
      </div>

      <div className="p-3 space-y-3">
        <p className="text-[11px] font-sans text-text-subtle">
          A Slack <strong>incoming webhook URL</strong> — its channel is part of the URL, so no Slack
          app or bot token is needed. Create one at <em>Slack → Apps → Incoming Webhooks</em>. Stored
          URLs are masked here; they are only ever readable by super admins.
        </p>

        {notifications.length > 0 && (
          <table className="w-full text-sm font-sans">
            <tbody>
              {notifications.map(n => (
                <tr key={n.id} className="border-t border-border">
                  <td className="px-2 py-2 font-semibold">{n.label}</td>
                  <td className="px-2 py-2 font-mono text-[11px] text-text-subtle">
                    {maskWebhook(n.webhook_url)}
                  </td>
                  <td className="px-2 py-2 text-[11px] text-text-muted">
                    {n.notify_all ? 'every occurrence' : 'new errors only'}
                  </td>
                  <td className="px-2 py-2 text-right whitespace-nowrap space-x-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(() => setNotificationEnabled(n.id, !n.enabled), 'config.NotificationSettings.toggle')}
                      className="text-[11px] hover:underline"
                    >
                      {n.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`Remove “${n.label}”?`)) return
                        void run(() => removeNotification(n.id), 'config.NotificationSettings.remove')
                      }}
                      className="text-[11px] text-signal-error hover:underline"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="#dev-alerts"
            className="w-40 border border-border rounded-sm px-2 py-1 text-sm bg-bg"
          />
          <input
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://hooks.slack.com/services/…"
            className="flex-1 min-w-[16rem] border border-border rounded-sm px-2 py-1 font-mono text-[11px] bg-bg"
          />
          <label className="flex items-center gap-1.5 text-[11px] font-sans text-text-muted">
            <input type="checkbox" checked={notifyAll} onChange={e => setNotifyAll(e.target.checked)} />
            every occurrence
          </label>
          <button
            type="button"
            disabled={busy || !label.trim() || !url.trim()}
            onClick={() => void run(async () => {
              await addNotification(label, url, notifyAll)
              setLabel(''); setUrl(''); setNotifyAll(false)
            }, 'config.NotificationSettings.add')}
            className="px-3 py-1.5 text-[11px] font-sans font-semibold border border-cosmos-black rounded-sm hover:bg-cosmos-black hover:text-clear-white transition-colors disabled:opacity-40"
          >
            Add
          </button>
        </div>

        {/* Leaving this off is the safe default: a looping component would otherwise post hundreds of
            times, the channel gets muted, and a muted alert channel looks like monitoring while being
            none. */}
        <p className="text-[11px] font-sans text-text-subtle">
          “Every occurrence” is off by default — digests carry errors seen for the first time.
        </p>

        {error && <p className="text-sm font-sans text-signal-error">{error}</p>}
      </div>
    </div>
  )
}
