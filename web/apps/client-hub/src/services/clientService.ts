import { supabase } from '../lib/supabase'
import type { Client } from '@dc-hub/asset-library'
import { toClientIdentity as toClient, dimensionLabelsToJson, DEFAULT_DIMENSION_LABELS } from '@dc-hub/database'
import type { ClientRow, TablesUpdate } from '@dc-hub/database'

/**
 * Row → domain. The projection itself lives in @dc-hub/database, beside the generated row type, so
 * desktop reads a client exactly the way the portal does. Kept as a named re-export because it is
 * part of this service's surface.
 */
export { toClient }

export async function fetchClients(): Promise<Client[]> {
  if (!supabase) throw new Error('Supabase not configured')

  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .order('name')

  if (error) throw new Error(error.message)
  return (data ?? []).map(toClient)
}

export async function createClient(input: Omit<Client, 'id'>): Promise<Client> {
  if (!supabase) throw new Error('Supabase not configured')

  const { data, error } = await supabase
    .from('clients')
    .insert({
      name:             input.name,
      slug:             input.slug ?? null,
      accent:           input.accent,
      initials:         input.initials,
      logo_url:         input.logoUrl ?? null,
      website:          input.website ?? null,
      portal_bg:        input.portalBg ?? null,
      domain_whitelist: input.domainWhitelist ?? [],
      dimension_labels: dimensionLabelsToJson(input.dimensionLabels ?? DEFAULT_DIMENSION_LABELS),
      preview_page_limit: input.previewPageLimit,
    })
    .select()
    .single()

  if (error || !data) throw new Error(error?.message ?? 'No data returned')
  return toClient(data as ClientRow)
}

export async function updateClient(id: string, input: Partial<Omit<Client, 'id'>>): Promise<Client> {
  if (!supabase) throw new Error('Supabase not configured')

  const patch: TablesUpdate<'clients'> = {}
  if (input.name      !== undefined) patch.name             = input.name
  if (input.slug      !== undefined) patch.slug             = input.slug || null
  if (input.accent    !== undefined) patch.accent           = input.accent
  if (input.initials  !== undefined) patch.initials         = input.initials
  if (input.logoUrl   !== undefined) patch.logo_url         = input.logoUrl || null
  if (input.website   !== undefined) patch.website          = input.website || null
  if (input.portalBg  !== undefined) patch.portal_bg        = input.portalBg || null
  if (input.domainWhitelist !== undefined) patch.domain_whitelist = input.domainWhitelist
  if (input.dimensionLabels !== undefined) patch.dimension_labels = dimensionLabelsToJson(input.dimensionLabels)
  if (input.previewPageLimit !== undefined) patch.preview_page_limit = input.previewPageLimit

  const { data, error } = await supabase
    .from('clients')
    .update(patch)
    .eq('id', id)
    .select()
    .single() as { data: ClientRow | null; error: { message: string } | null }

  if (error || !data) throw new Error(error?.message ?? 'No data returned')
  return toClient(data as ClientRow)
}

export async function deleteClient(id: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.from('clients').delete().eq('id', id)
  if (error) throw new Error(error.message)
}
