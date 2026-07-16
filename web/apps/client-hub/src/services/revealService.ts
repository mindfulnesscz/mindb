/**
 * Ask the running DC Hub desktop app to reveal a package in Finder / Explorer.
 * Bridge: http://127.0.0.1:7624 (started with the desktop app).
 */
const REVEAL_URL = 'http://127.0.0.1:7624/reveal'

export type RevealResult =
  | { ok: true; path: string }
  | { ok: false; error: string; desktopMissing?: boolean }

export async function revealInDesktop(clientId: string, stableId: string): Promise<RevealResult> {
  try {
    const res = await fetch(REVEAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, stableId }),
    })
    const data = await res.json().catch(() => ({})) as { ok?: boolean; path?: string; error?: string }
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error ?? `Desktop responded ${res.status}` }
    }
    return { ok: true, path: data.path ?? '' }
  } catch {
    return {
      ok: false,
      desktopMissing: true,
      error: 'DC Hub desktop is not running (or the reveal bridge is offline). Open the desktop app with this client selected, then try again.',
    }
  }
}

export async function desktopRevealAvailable(): Promise<boolean> {
  try {
    const res = await fetch('http://127.0.0.1:7624/health', { method: 'GET' })
    return res.ok
  } catch {
    return false
  }
}
