import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect, useRef } from 'react';
import { useClients } from '../../hooks/useClients';
import { useRole } from '../../context/RoleContext';
import { createClient, updateClient } from '../../services/clientService';
// ── Helpers ───────────────────────────────────────────────────
function initials(name) {
    return name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map(w => w[0].toUpperCase())
        .join('');
}
// ── Domain whitelist tag input ─────────────────────────────────
function DomainInput({ value, onChange, }) {
    const [draft, setDraft] = useState('');
    const inputRef = useRef(null);
    function add(raw) {
        const domain = raw.trim().toLowerCase().replace(/^@/, '');
        if (!domain || value.includes(domain)) {
            setDraft('');
            return;
        }
        onChange([...value, domain]);
        setDraft('');
    }
    function remove(domain) {
        onChange(value.filter(d => d !== domain));
    }
    function onKeyDown(e) {
        if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
            e.preventDefault();
            add(draft);
        }
        else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
            onChange(value.slice(0, -1));
        }
    }
    return (_jsxs("div", { className: "min-h-[38px] flex flex-wrap gap-1.5 items-center border border-border rounded-sm px-2 py-1.5 bg-bg focus-within:border-cosmos-black transition-colors cursor-text", onClick: () => inputRef.current?.focus(), children: [value.map(d => (_jsxs("span", { className: "flex items-center gap-1 text-[11px] font-mono bg-gray-100 border border-border rounded-chip px-2 py-0.5", children: [d, _jsx("button", { type: "button", onClick: e => { e.stopPropagation(); remove(d); }, className: "text-text-muted hover:text-cosmos-black leading-none", children: "\u00D7" })] }, d))), _jsx("input", { ref: inputRef, value: draft, onChange: e => setDraft(e.target.value), onKeyDown: onKeyDown, onBlur: () => draft.trim() && add(draft), placeholder: value.length === 0 ? 'acme.com, client.io…' : '', className: "flex-1 min-w-[120px] text-sm font-mono bg-transparent outline-none placeholder:text-text-subtle" })] }));
}
// ── Client form ────────────────────────────────────────────────
function toSlug(name) {
    return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function emptyForm() {
    return { name: '', slug: '', initials: '', accent: '#161616', logoUrl: '', website: '', portalBg: '', domainWhitelist: [] };
}
function clientToForm(c) {
    return {
        name: c.name,
        slug: c.slug ?? '',
        initials: c.initials,
        accent: c.accent,
        logoUrl: c.logoUrl ?? '',
        website: c.website ?? '',
        portalBg: c.portalBg ?? '',
        domainWhitelist: c.domainWhitelist ?? [],
    };
}
// ── Drawer ─────────────────────────────────────────────────────
function ClientDrawer({ editing, onClose, onSaved, }) {
    const [form, setForm] = useState(editing ? clientToForm(editing) : emptyForm());
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => {
        setForm(editing ? clientToForm(editing) : emptyForm());
        setError('');
    }, [editing]);
    function set(key, val) {
        setForm(f => ({ ...f, [key]: val }));
        if (key === 'name' && !editing) {
            setForm(f => ({ ...f, name: val, initials: initials(val), slug: toSlug(val) }));
        }
    }
    async function handleSubmit(e) {
        e.preventDefault();
        if (!form.name.trim())
            return;
        setSaving(true);
        setError('');
        try {
            const payload = {
                name: form.name.trim(),
                slug: form.slug.trim() || undefined,
                initials: form.initials.trim() || initials(form.name),
                accent: form.accent,
                logoUrl: form.logoUrl.trim() || undefined,
                website: form.website.trim() || undefined,
                portalBg: form.portalBg.trim() || undefined,
                domainWhitelist: form.domainWhitelist,
            };
            const saved = editing
                ? await updateClient(editing.id, payload)
                : await createClient(payload);
            onSaved(saved);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
        finally {
            setSaving(false);
        }
    }
    const isNew = !editing;
    return (_jsxs(_Fragment, { children: [_jsx("div", { className: "fixed inset-0 bg-cosmos-black/20 z-40", onClick: onClose }), _jsxs("div", { className: "fixed right-0 top-0 h-full w-full max-w-[420px] bg-bg border-l border-border z-50 flex flex-col shadow-xl", children: [_jsxs("div", { className: "flex items-center justify-between px-6 py-4 border-b border-border shrink-0", children: [_jsx("h2", { className: "font-serif text-lg font-medium text-cosmos-black", children: isNew ? 'New client' : `Edit — ${editing.name}` }), _jsx("button", { onClick: onClose, className: "text-text-muted hover:text-cosmos-black transition-colors text-xl leading-none", children: "\u00D7" })] }), _jsxs("form", { onSubmit: handleSubmit, className: "flex-1 overflow-y-auto px-6 py-6 space-y-5", children: [_jsxs("div", { children: [_jsxs("label", { className: "block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5", children: ["Name ", _jsx("span", { className: "text-signal-error", children: "*" })] }), _jsx("input", { type: "text", value: form.name, onChange: e => set('name', e.target.value), placeholder: "Acme Corp", required: true, className: "w-full text-sm font-sans border border-border rounded-sm px-3 py-2 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors" })] }), _jsxs("div", { className: "flex gap-3", children: [_jsxs("div", { className: "flex-1", children: [_jsx("label", { className: "block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5", children: "Initials" }), _jsx("input", { type: "text", value: form.initials, onChange: e => set('initials', e.target.value.toUpperCase().slice(0, 3)), placeholder: "AC", maxLength: 3, className: "w-full text-sm font-sans font-mono border border-border rounded-sm px-3 py-2 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors uppercase" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5", children: "Brand colour" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("input", { type: "color", value: form.accent, onChange: e => set('accent', e.target.value), className: "w-10 h-[38px] rounded-sm border border-border cursor-pointer p-0.5 bg-bg" }), _jsx("input", { type: "text", value: form.accent, onChange: e => /^#[0-9a-fA-F]{0,6}$/.test(e.target.value) && set('accent', e.target.value), className: "w-24 text-sm font-mono border border-border rounded-sm px-3 py-2 bg-bg focus:outline-none focus:border-cosmos-black transition-colors" })] })] })] }), _jsxs("div", { className: "flex items-center gap-3 p-3 bg-surface-sunken rounded-sm border border-border", children: [form.logoUrl ? (_jsx("img", { src: form.logoUrl, alt: "", className: "w-10 h-10 rounded-[28%_38%] object-cover", onError: e => { e.target.style.display = 'none'; } })) : (_jsx("div", { className: "w-10 h-10 rounded-[28%_38%] flex items-center justify-center text-sm font-bold font-sans text-clear-white shrink-0", style: { backgroundColor: form.accent }, children: form.initials || initials(form.name) || '?' })), _jsxs("div", { children: [_jsx("p", { className: "text-sm font-sans font-semibold text-cosmos-black", children: form.name || 'Client name' }), form.website && (_jsx("p", { className: "text-[11px] font-sans text-text-muted", children: form.website }))] })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5", children: "Logo URL" }), _jsx("input", { type: "url", value: form.logoUrl, onChange: e => set('logoUrl', e.target.value), placeholder: "https://acme.com/logo.png", className: "w-full text-sm font-sans font-mono border border-border rounded-sm px-3 py-2 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors" }), _jsx("p", { className: "text-[11px] font-sans text-text-subtle mt-1", children: "Replaces the initials badge when set." })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5", children: "Website" }), _jsx("input", { type: "url", value: form.website, onChange: e => set('website', e.target.value), placeholder: "https://acme.com", className: "w-full text-sm font-sans font-mono border border-border rounded-sm px-3 py-2 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5", children: "Portal URL slug" }), _jsxs("div", { className: "flex items-center border border-border rounded-sm overflow-hidden focus-within:border-cosmos-black transition-colors", children: [_jsx("span", { className: "px-3 py-2 text-sm font-sans text-text-muted bg-surface-sunken border-r border-border whitespace-nowrap", children: "/" }), _jsx("input", { type: "text", value: form.slug, onChange: e => set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')), placeholder: "acme-corp", className: "flex-1 px-3 py-2 text-sm font-mono bg-bg placeholder:text-text-subtle focus:outline-none" })] }), _jsx("p", { className: "text-[11px] font-sans text-text-subtle mt-1", children: "Share this URL with clients to give them a branded sign-in page." })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5", children: "Portal background" }), _jsx("input", { type: "text", value: form.portalBg, onChange: e => set('portalBg', e.target.value), placeholder: "#f5f0eb  or  https://\u2026/hero.jpg", className: "w-full text-sm font-sans font-mono border border-border rounded-sm px-3 py-2 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors" }), _jsx("p", { className: "text-[11px] font-sans text-text-subtle mt-1", children: "CSS colour or image URL shown on the portal welcome screen." })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5", children: "Domain whitelist" }), _jsx(DomainInput, { value: form.domainWhitelist, onChange: v => set('domainWhitelist', v) }), _jsx("p", { className: "text-[11px] font-sans text-text-subtle mt-1", children: "Users with a matching email domain are auto-assigned to this client. Press Enter or comma to add." })] }), error && (_jsx("p", { className: "text-[11px] font-sans text-signal-error", children: error }))] }), _jsxs("div", { className: "flex items-center justify-between px-6 py-4 border-t border-border shrink-0", children: [_jsx("button", { type: "button", onClick: onClose, className: "text-sm font-sans text-text-muted hover:text-cosmos-black transition-colors", children: "Cancel" }), _jsx("button", { type: "submit", form: "", onClick: handleSubmit, disabled: saving || !form.name.trim(), className: "px-4 py-2 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm disabled:opacity-40 hover:bg-ink-800 transition-colors", style: form.name.trim() ? { boxShadow: '4px 4px 0 #161616' } : undefined, children: saving ? 'Saving…' : isNew ? 'Create client' : 'Save changes' })] })] })] }));
}
// ── Client card ─────────────────────────────────────────────────
function ClientCard({ client, active, onSelect, onEdit, }) {
    return (_jsxs("div", { className: `relative group p-5 bg-surface border rounded-sm transition-colors cursor-pointer ${active ? 'border-cosmos-black' : 'border-border hover:border-cosmos-black'}`, style: active ? { boxShadow: '4px 4px 0 #161616' } : undefined, onClick: onSelect, children: [_jsx("button", { onClick: e => { e.stopPropagation(); onEdit(); }, className: "absolute top-3 right-3 opacity-0 group-hover:opacity-100 text-[11px] font-sans text-text-muted hover:text-cosmos-black transition-all px-2 py-1 rounded-chip border border-transparent hover:border-border", children: "Edit" }), client.logoUrl ? (_jsx("img", { src: client.logoUrl, alt: client.name, className: "w-10 h-10 rounded-[28%_38%] object-cover mb-3" })) : (_jsx("div", { className: "w-10 h-10 rounded-[28%_38%] flex items-center justify-center mb-3 text-sm font-bold font-sans text-clear-white", style: { backgroundColor: client.accent }, children: client.initials })), _jsx("h3", { className: "font-sans text-base font-semibold text-cosmos-black mb-0.5", children: client.name }), client.website ? (_jsx("p", { className: "text-[11px] font-sans text-text-muted truncate", children: client.website.replace(/^https?:\/\//, '') })) : (_jsxs("p", { className: "text-[11px] font-sans text-text-subtle uppercase tracking-label truncate", children: [client.id.slice(0, 8), "\u2026"] })), client.domainWhitelist && client.domainWhitelist.length > 0 && (_jsxs("div", { className: "flex flex-wrap gap-1 mt-2", children: [client.domainWhitelist.slice(0, 3).map(d => (_jsxs("span", { className: "text-[10px] font-mono bg-gray-100 border border-border rounded-chip px-1.5 py-0.5", children: ["@", d] }, d))), client.domainWhitelist.length > 3 && (_jsxs("span", { className: "text-[10px] font-sans text-text-muted px-1 py-0.5", children: ["+", client.domainWhitelist.length - 3] }))] }))] }));
}
// ── Main view ──────────────────────────────────────────────────
export default function ClientsView() {
    const { activeClient, setActiveClient } = useRole();
    const { clients, loading, error, usingMock, reload } = useClients();
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [editingClient, setEditingClient] = useState(null);
    function openCreate() {
        setEditingClient(null);
        setDrawerOpen(true);
    }
    function openEdit(client) {
        setEditingClient(client);
        setDrawerOpen(true);
    }
    function closeDrawer() {
        setDrawerOpen(false);
        setEditingClient(null);
    }
    function handleSaved(saved) {
        reload();
        closeDrawer();
        if (!editingClient)
            setActiveClient(saved);
    }
    return (_jsxs("div", { className: "px-5 py-8", children: [_jsxs("div", { className: "flex items-center justify-between mb-6", children: [_jsx("h1", { className: "font-serif text-2xl font-medium text-cosmos-black", children: "Clients" }), !usingMock && (_jsx("button", { onClick: openCreate, className: "text-sm font-sans font-semibold border-2 border-cosmos-black px-4 py-2 rounded-sm bg-bg text-cosmos-black hover:bg-cosmos-black hover:text-clear-white transition-colors", style: { boxShadow: '4px 4px 0 #161616' }, children: "+ New client" }))] }), _jsxs("p", { className: "font-sans text-sm text-text-muted mb-8", children: ["Each client is a separate workspace. Selecting one sets the accent colour and filters the gallery to their assets.", usingMock && _jsx("span", { className: "ml-2 opacity-60", children: "(demo \u2014 connect Supabase to manage real clients)" })] }), error && (_jsx("p", { className: "text-sm font-sans text-signal-error mb-6", children: error })), loading ? (_jsx("div", { className: "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4", children: [1, 2, 3].map(i => (_jsx("div", { className: "h-32 bg-surface-sunken border border-border rounded-sm animate-pulse" }, i))) })) : (_jsx("div", { className: "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4", children: clients.map(client => (_jsx(ClientCard, { client: client, active: activeClient?.id === client.id, onSelect: () => setActiveClient(client), onEdit: () => openEdit(client) }, client.id))) })), drawerOpen && (_jsx(ClientDrawer, { editing: editingClient, onClose: closeDrawer, onSaved: handleSaved }))] }));
}
