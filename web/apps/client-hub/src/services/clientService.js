import { supabase } from '../lib/supabase';
export function toClient(row) {
    return {
        id: row.id,
        name: row.name,
        slug: row.slug ?? undefined,
        accent: row.accent,
        initials: row.initials,
        logoUrl: row.logo_url ?? undefined,
        website: row.website ?? undefined,
        portalBg: row.portal_bg ?? undefined,
        domainWhitelist: row.domain_whitelist,
    };
}
export async function fetchClients() {
    if (!supabase)
        throw new Error('Supabase not configured');
    const { data, error } = await supabase
        .from('clients')
        .select('*')
        .order('name');
    if (error)
        throw new Error(error.message);
    return (data ?? []).map(toClient);
}
export async function createClient(input) {
    if (!supabase)
        throw new Error('Supabase not configured');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await supabase
        .from('clients')
        .insert({
        name: input.name,
        slug: input.slug ?? null,
        accent: input.accent,
        initials: input.initials,
        logo_url: input.logoUrl ?? null,
        website: input.website ?? null,
        portal_bg: input.portalBg ?? null,
        domain_whitelist: input.domainWhitelist ?? [],
    })
        .select()
        .single();
    if (error || !data)
        throw new Error(error?.message ?? 'No data returned');
    return toClient(data);
}
export async function updateClient(id, input) {
    if (!supabase)
        throw new Error('Supabase not configured');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const patch = {};
    if (input.name !== undefined)
        patch.name = input.name;
    if (input.slug !== undefined)
        patch.slug = input.slug || null;
    if (input.accent !== undefined)
        patch.accent = input.accent;
    if (input.initials !== undefined)
        patch.initials = input.initials;
    if (input.logoUrl !== undefined)
        patch.logo_url = input.logoUrl || null;
    if (input.website !== undefined)
        patch.website = input.website || null;
    if (input.portalBg !== undefined)
        patch.portal_bg = input.portalBg || null;
    if (input.domainWhitelist !== undefined)
        patch.domain_whitelist = input.domainWhitelist;
    const { data, error } = await supabase
        .from('clients')
        .update(patch)
        .eq('id', id)
        .select()
        .single();
    if (error || !data)
        throw new Error(error?.message ?? 'No data returned');
    return toClient(data);
}
export async function deleteClient(id) {
    if (!supabase)
        throw new Error('Supabase not configured');
    const { error } = await supabase.from('clients').delete().eq('id', id);
    if (error)
        throw new Error(error.message);
}
