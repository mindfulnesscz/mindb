import { supabase } from '../lib/supabase'

export async function uploadClientLogo(clientId: string, file: File): Promise<string> {
  if (!supabase) throw new Error('Supabase not configured')

  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  const data_base64 = btoa(binary)

  const { data: session } = await supabase.auth.getSession()
  const token = session.session?.access_token
  if (!token) throw new Error('Not signed in')

  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/r2-branding-upload`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      client_id: clientId,
      filename: file.name,
      content_type: file.type,
      data_base64,
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(err.error ?? `Upload failed (${res.status})`)
  }

  const body = await res.json() as { logo_url: string }
  return body.logo_url
}
