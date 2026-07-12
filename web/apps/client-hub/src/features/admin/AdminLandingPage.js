import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useClients } from '../../hooks/useClients';
import { createClient, updateClient } from '../../services/clientService';
import { fetchAllUsers, updateUserRole } from '../../services/userService';
import { isConfigured } from '../../lib/supabase';
// ── DC logo mark ──────────────────────────────────────────────
function DCMark({ size = 'sm' }) {
    const dim = size === 'lg' ? 'w-16 h-16' : 'w-7 h-7';
    const text = size === 'lg' ? 'text-2xl' : 'text-xs';
    return (_jsx("div", { className: `${dim} rounded-[28%_38%] bg-cosmos-black flex items-center justify-center shrink-0`, style: size === 'lg' ? { boxShadow: '6px 6px 0 #161616' } : undefined, children: _jsx("span", { className: `text-clear-white ${text} font-bold font-sans leading-none`, children: "C" }) }));
}
// ── Domain whitelist tag input ────────────────────────────────
function DomainInput({ value, onChange }) {
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
    function remove(domain) { onChange(value.filter(d => d !== domain)); }
    function onKeyDown(e) {
        if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
            e.preventDefault();
            add(draft);
        }
        else if (e.key === 'Backspace' && draft === '' && value.length > 0)
            onChange(value.slice(0, -1));
    }
    return (_jsxs("div", { className: "min-h-[38px] flex flex-wrap gap-1.5 items-center border border-border rounded-sm px-2 py-1.5 bg-bg focus-within:border-cosmos-black transition-colors cursor-text", onClick: () => inputRef.current?.focus(), children: [value.map(d => (_jsxs("span", { className: "flex items-center gap-1 text-[11px] font-mono bg-gray-100 border border-border rounded-chip px-2 py-0.5", children: [d, _jsx("button", { type: "button", onClick: e => { e.stopPropagation(); remove(d); }, className: "text-text-muted hover:text-cosmos-black leading-none", children: "\u00D7" })] }, d))), _jsx("input", { ref: inputRef, value: draft, onChange: e => setDraft(e.target.value), onKeyDown: onKeyDown, onBlur: () => draft.trim() && add(draft), placeholder: value.length === 0 ? 'acme.com, client.io…' : '', className: "flex-1 min-w-[120px] text-sm font-mono bg-transparent outline-none placeholder:text-text-subtle" })] }));
}
// ── Client form helpers ───────────────────────────────────────
function getInitials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}
function toSlug(name) {
    return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function emptyForm() {
    return { name: '', slug: '', initials: '', accent: '#161616', logoUrl: '', website: '', portalBg: '', domainWhitelist: [] };
}
function clientToForm(c) {
    return {
        name: c.name, slug: c.slug ?? '', initials: c.initials, accent: c.accent,
        logoUrl: c.logoUrl ?? '', website: c.website ?? '', portalBg: c.portalBg ?? '',
        domainWhitelist: c.domainWhitelist ?? [],
    };
}
const inputCls = 'w-full text-sm font-sans border border-border rounded-sm px-3 py-2 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors';
// ── Client drawer ─────────────────────────────────────────────
function ClientDrawer({ editing, onClose, onSaved }) {
    const [form, setForm] = useState(editing ? clientToForm(editing) : emptyForm());
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => { setForm(editing ? clientToForm(editing) : emptyForm()); setError(''); }, [editing]);
    function set(key, val) {
        if (key === 'name' && !editing) {
            setForm(f => ({ ...f, name: val, initials: getInitials(val), slug: toSlug(val) }));
        }
        else {
            setForm(f => ({ ...f, [key]: val }));
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
                name: form.name.trim(), slug: form.slug.trim() || undefined,
                initials: form.initials.trim() || getInitials(form.name), accent: form.accent,
                logoUrl: form.logoUrl.trim() || undefined, website: form.website.trim() || undefined,
                portalBg: form.portalBg.trim() || undefined, domainWhitelist: form.domainWhitelist,
            };
            editing ? await updateClient(editing.id, payload) : await createClient(payload);
            onSaved();
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
        finally {
            setSaving(false);
        }
    }
    return (_jsxs(_Fragment, { children: [_jsx("div", { className: "fixed inset-0 bg-cosmos-black/20 z-40", onClick: onClose }), _jsxs("div", { className: "fixed right-0 top-0 h-full w-full max-w-[420px] bg-bg border-l border-border z-50 flex flex-col shadow-xl", children: [_jsxs("div", { className: "flex items-center justify-between px-6 py-4 border-b border-border shrink-0", children: [_jsx("h2", { className: "font-serif text-lg font-medium text-cosmos-black", children: editing ? `Edit — ${editing.name}` : 'New client' }), _jsx("button", { onClick: onClose, className: "text-text-muted hover:text-cosmos-black transition-colors text-xl leading-none", children: "\u00D7" })] }), _jsxs("form", { onSubmit: handleSubmit, id: "client-form", className: "flex-1 overflow-y-auto px-6 py-6 space-y-5", children: [_jsxs("div", { children: [_jsxs("label", { className: "block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5", children: ["Name ", _jsx("span", { className: "text-signal-error", children: "*" })] }), _jsx("input", { type: "text", value: form.name, onChange: e => set('name', e.target.value), placeholder: "Acme Corp", required: true, className: inputCls })] }), _jsxs("div", { className: "flex gap-3", children: [_jsxs("div", { className: "flex-1", children: [_jsx("label", { className: "block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5", children: "Initials" }), _jsx("input", { type: "text", value: form.initials, onChange: e => set('initials', e.target.value.toUpperCase().slice(0, 3)), placeholder: "AC", maxLength: 3, className: `${inputCls} font-mono uppercase` })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5", children: "Brand colour" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("input", { type: "color", value: form.accent, onChange: e => set('accent', e.target.value), className: "w-10 h-[38px] rounded-sm border border-border cursor-pointer p-0.5 bg-bg" }), _jsx("input", { type: "text", value: form.accent, onChange: e => /^#[0-9a-fA-F]{0,6}$/.test(e.target.value) && set('accent', e.target.value), className: "w-24 text-sm font-mono border border-border rounded-sm px-3 py-2 bg-bg focus:outline-none focus:border-cosmos-black transition-colors" })] })] })] }), _jsxs("div", { className: "flex items-center gap-3 p-3 bg-surface-sunken rounded-sm border border-border", children: [form.logoUrl
                                        ? _jsx("img", { src: form.logoUrl, alt: "", className: "w-10 h-10 rounded-[28%_38%] object-cover", onError: e => { e.target.style.display = 'none'; } })
                                        : _jsx("div", { className: "w-10 h-10 rounded-[28%_38%] flex items-center justify-center text-sm font-bold font-sans text-clear-white shrink-0", style: { backgroundColor: form.accent }, children: form.initials || getInitials(form.name) || '?' }), _jsxs("div", { children: [_jsx("p", { className: "text-sm font-sans font-semibold text-cosmos-black", children: form.name || 'Client name' }), form.website && _jsx("p", { className: "text-[11px] font-sans text-text-muted", children: form.website })] })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5", children: "Logo URL" }), _jsx("input", { type: "url", value: form.logoUrl, onChange: e => set('logoUrl', e.target.value), placeholder: "https://acme.com/logo.png", className: `${inputCls} font-mono` })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5", children: "Website" }), _jsx("input", { type: "url", value: form.website, onChange: e => set('website', e.target.value), placeholder: "https://acme.com", className: `${inputCls} font-mono` })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5", children: "Portal URL slug" }), _jsxs("div", { className: "flex items-center border border-border rounded-sm overflow-hidden focus-within:border-cosmos-black transition-colors", children: [_jsx("span", { className: "px-3 py-2 text-sm font-sans text-text-muted bg-surface-sunken border-r border-border whitespace-nowrap", children: "/" }), _jsx("input", { type: "text", value: form.slug, onChange: e => set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')), placeholder: "acme-corp", className: "flex-1 px-3 py-2 text-sm font-mono bg-bg placeholder:text-text-subtle focus:outline-none" })] }), _jsx("p", { className: "text-[11px] font-sans text-text-subtle mt-1", children: "Share this URL with clients for their branded sign-in page." })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5", children: "Portal background" }), _jsx("input", { type: "text", value: form.portalBg, onChange: e => set('portalBg', e.target.value), placeholder: "#f5f0eb  or  https://\u2026/hero.jpg", className: `${inputCls} font-mono` }), _jsx("p", { className: "text-[11px] font-sans text-text-subtle mt-1", children: "CSS colour or image URL on the portal welcome screen." })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5", children: "Domain whitelist" }), _jsx(DomainInput, { value: form.domainWhitelist, onChange: v => set('domainWhitelist', v) }), _jsx("p", { className: "text-[11px] font-sans text-text-subtle mt-1", children: "Users with matching email domains are auto-assigned to this client. Press Enter or comma to add." })] }), error && _jsx("p", { className: "text-[11px] font-sans text-signal-error", children: error })] }), _jsxs("div", { className: "flex items-center justify-between px-6 py-4 border-t border-border shrink-0", children: [_jsx("button", { type: "button", onClick: onClose, className: "text-sm font-sans text-text-muted hover:text-cosmos-black transition-colors", children: "Cancel" }), _jsx("button", { form: "client-form", type: "submit", disabled: saving || !form.name.trim(), className: "px-4 py-2 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm disabled:opacity-40 hover:bg-ink-800 transition-colors", style: form.name.trim() ? { boxShadow: '4px 4px 0 #161616' } : undefined, children: saving ? 'Saving…' : editing ? 'Save changes' : 'Create client' })] })] })] }));
}
// ── Admin client card ─────────────────────────────────────────
function AdminClientCard({ client, onNavigate, onEdit }) {
    return (_jsxs("div", { className: "relative group p-5 bg-surface border border-border hover:border-cosmos-black rounded-sm transition-colors cursor-pointer", onClick: onNavigate, children: [_jsx("button", { onClick: e => { e.stopPropagation(); onEdit(); }, className: "absolute top-3 right-3 opacity-0 group-hover:opacity-100 text-[11px] font-sans text-text-muted hover:text-cosmos-black transition-all px-2 py-1 rounded-chip border border-transparent hover:border-border", children: "Edit" }), client.logoUrl ? (_jsx("img", { src: client.logoUrl, alt: client.name, className: "w-10 h-10 rounded-[28%_38%] object-cover mb-3" })) : (_jsx("div", { className: "w-10 h-10 rounded-[28%_38%] flex items-center justify-center mb-3 text-sm font-bold font-sans text-clear-white", style: { backgroundColor: client.accent }, children: client.initials })), _jsx("h3", { className: "font-sans text-base font-semibold text-cosmos-black mb-0.5", children: client.name }), client.slug && (_jsxs("p", { className: "text-[11px] font-mono text-text-muted mb-0.5", children: ["/", client.slug] })), client.website && (_jsx("p", { className: "text-[11px] font-sans text-text-subtle truncate", children: client.website.replace(/^https?:\/\//, '') })), client.domainWhitelist && client.domainWhitelist.length > 0 && (_jsxs("div", { className: "flex flex-wrap gap-1 mt-2", children: [client.domainWhitelist.slice(0, 3).map(d => (_jsxs("span", { className: "text-[10px] font-mono bg-gray-100 border border-border rounded-chip px-1.5 py-0.5", children: ["@", d] }, d))), client.domainWhitelist.length > 3 && (_jsxs("span", { className: "text-[10px] font-sans text-text-muted px-1 py-0.5", children: ["+", client.domainWhitelist.length - 3] }))] })), _jsxs("div", { className: "mt-4 flex items-center gap-1 text-[11px] font-sans text-text-muted group-hover:text-cosmos-black transition-colors", children: [_jsx("span", { children: "Open portal" }), _jsx("span", { children: "\u2192" })] })] }));
}
function AdminSignIn() {
    const { checkEmail, sendMagicLink } = useAuth();
    const [step, setStep] = useState('email');
    const [email, setEmail] = useState('');
    const [error, setError] = useState('');
    const inputRef = useRef(null);
    useEffect(() => { inputRef.current?.focus(); }, []);
    // Detect auth errors Supabase puts in the URL hash (e.g. expired link)
    useEffect(() => {
        const hash = window.location.hash;
        if (!hash.includes('error='))
            return;
        const params = new URLSearchParams(hash.slice(1));
        const desc = params.get('error_description');
        if (desc)
            setError(desc.replace(/\+/g, ' ') + ' — please try again.');
        window.history.replaceState(null, '', window.location.pathname);
    }, []);
    async function handleSubmit(e) {
        e.preventDefault();
        const trimmed = email.trim().toLowerCase();
        if (!trimmed)
            return;
        setError('');
        setStep('checking');
        const type = await checkEmail(trimmed);
        if (type !== 'staff') {
            setError('This area is restricted to DC Hub administrators.');
            setStep('error');
            return;
        }
        setStep('sending');
        const err = await sendMagicLink(trimmed, undefined, window.location.origin);
        if (err) {
            setError(err);
            setStep('email');
        }
        else
            setStep('sent');
    }
    const busy = step === 'checking' || step === 'sending';
    return (_jsxs("div", { className: "min-h-screen flex flex-col items-center justify-center bg-bg px-4", children: [_jsxs("div", { className: "mb-10 text-center", children: [_jsx("div", { className: "flex justify-center mb-4", children: _jsx(DCMark, { size: "lg" }) }), _jsx("h1", { className: "font-serif text-3xl font-medium text-cosmos-black mb-1", children: "DC Hub" }), _jsx("p", { className: "font-sans text-sm text-text-muted", children: "Admin access only" })] }), _jsx("div", { className: "w-full max-w-sm", children: step === 'sent' ? (_jsxs("div", { className: "border border-cosmos-black rounded-sm p-6", style: { boxShadow: '4px 4px 0 #161616' }, children: [_jsx("p", { className: "font-serif text-lg font-medium text-cosmos-black mb-2", children: "Check your email" }), _jsxs("p", { className: "font-sans text-sm text-text-muted mb-1", children: ["We sent a magic link to ", _jsx("span", { className: "font-mono text-cosmos-black", children: email })] }), _jsx("p", { className: "text-[11px] font-sans text-text-subtle mb-4", children: "Click the link to sign in. It expires in 1 hour." }), _jsx("button", { onClick: () => { setStep('email'); setEmail(''); setError(''); }, className: "text-[11px] font-sans text-text-muted hover:text-cosmos-black underline transition-colors", children: "Use a different email" })] })) : (_jsxs("form", { onSubmit: handleSubmit, className: "space-y-3", children: [_jsx("input", { ref: inputRef, type: "email", value: email, onChange: e => { setEmail(e.target.value); if (step === 'error') {
                                setStep('email');
                                setError('');
                            } }, placeholder: "admin@disruptcollective.com", required: true, disabled: busy, className: "w-full text-sm font-sans border border-cosmos-black rounded-sm px-4 py-3 bg-bg placeholder:text-text-subtle focus:outline-none transition-colors" }), error && _jsx("p", { className: "text-[11px] font-sans text-signal-error", children: error }), _jsx("button", { type: "submit", disabled: busy || !email.trim(), className: "w-full py-3 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm disabled:opacity-50 hover:bg-ink-800 transition-colors", style: { boxShadow: '4px 4px 0 #161616' }, children: busy ? 'Checking…' : 'Continue' })] })) })] }));
}
// ── Users view ────────────────────────────────────────────────
const ROLE_OPTIONS = ['public', 'member', 'editor', 'admin'];
const ROLE_LABELS = {
    public: 'Public', member: 'Member', editor: 'Editor', admin: 'Admin',
};
function UsersView({ isAdmin }) {
    const { profile: self } = useAuth();
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(null);
    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            setUsers(await fetchAllUsers());
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => { load(); }, [load]);
    async function handleRoleChange(userId, role) {
        setSaving(userId);
        try {
            await updateUserRole(userId, role);
            setUsers(u => u.map(p => p.id === userId ? { ...p, role } : p));
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            setSaving(null);
        }
    }
    if (loading)
        return (_jsx("div", { className: "space-y-2", children: [1, 2, 3].map(i => _jsx("div", { className: "h-14 bg-surface-sunken border border-border rounded-sm animate-pulse" }, i)) }));
    if (error)
        return _jsx("p", { className: "text-sm font-sans text-signal-error", children: error });
    return (_jsx("div", { className: "rounded-sm border border-border overflow-hidden", children: _jsxs("table", { className: "w-full text-sm font-sans", children: [_jsx("thead", { children: _jsxs("tr", { className: "border-b border-border bg-surface-sunken", children: [_jsx("th", { className: "text-left text-[10px] font-bold uppercase tracking-label text-text-muted px-4 py-3", children: "User" }), _jsx("th", { className: "text-left text-[10px] font-bold uppercase tracking-label text-text-muted px-4 py-3", children: "Email" }), _jsx("th", { className: "text-left text-[10px] font-bold uppercase tracking-label text-text-muted px-4 py-3", children: "Client" }), _jsx("th", { className: "text-left text-[10px] font-bold uppercase tracking-label text-text-muted px-4 py-3", children: "Role" })] }) }), _jsx("tbody", { children: users.map((u, i) => (_jsxs("tr", { className: `border-b border-border last:border-0 ${i % 2 === 0 ? 'bg-bg' : 'bg-surface-sunken/30'}`, children: [_jsx("td", { className: "px-4 py-3", children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("div", { className: "w-7 h-7 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center shrink-0", children: _jsx("span", { className: "text-clear-white text-[10px] font-bold font-sans leading-none", children: u.initials }) }), _jsx("span", { className: "text-cosmos-black font-medium", children: u.name })] }) }), _jsx("td", { className: "px-4 py-3 font-mono text-text-muted text-[11px]", children: u.email }), _jsx("td", { className: "px-4 py-3 text-text-muted", children: u.clientName ?? '—' }), _jsx("td", { className: "px-4 py-3", children: isAdmin && u.id !== self?.id ? (_jsx("select", { value: u.role, disabled: saving === u.id, onChange: e => handleRoleChange(u.id, e.target.value), className: "text-sm font-sans border border-border rounded-sm px-2 py-1 bg-bg focus:outline-none focus:border-cosmos-black transition-colors disabled:opacity-50 cursor-pointer", children: ROLE_OPTIONS.map(r => (_jsx("option", { value: r, children: ROLE_LABELS[r] }, r))) })) : (_jsx("span", { className: "text-[11px] font-mono px-2 py-1 bg-surface-sunken border border-border rounded-chip", children: ROLE_LABELS[u.role] ?? u.role })) })] }, u.id))) })] }) }));
}
// ── Admin dashboard ───────────────────────────────────────────
function AdminDashboard({ isAdmin }) {
    const { profile, signOut } = useAuth();
    const navigate = useNavigate();
    const { clients, loading, error, usingMock, reload } = useClients();
    const [tab, setTab] = useState('clients');
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [editingClient, setEditingClient] = useState(null);
    function openCreate() { setEditingClient(null); setDrawerOpen(true); }
    function openEdit(client) { setEditingClient(client); setDrawerOpen(true); }
    function closeDrawer() { setDrawerOpen(false); setEditingClient(null); }
    function handleSaved() { reload(); closeDrawer(); }
    const tabCls = (t) => `px-4 py-2 text-sm font-sans font-medium transition-colors border-b-2 ${tab === t
        ? 'border-cosmos-black text-cosmos-black'
        : 'border-transparent text-text-muted hover:text-cosmos-black'}`;
    return (_jsxs("div", { className: "min-h-screen flex flex-col bg-bg", children: [_jsxs("header", { className: "flex items-center gap-4 px-6 py-4 border-b border-border bg-surface shrink-0", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(DCMark, {}), _jsx("span", { className: "font-sans text-sm font-bold tracking-[0.14em] uppercase text-cosmos-black", children: "DC HUB" })] }), _jsxs("div", { className: "flex gap-1 ml-4", children: [_jsx("button", { className: tabCls('clients'), onClick: () => setTab('clients'), children: "Clients" }), isAdmin && (_jsx("button", { className: tabCls('users'), onClick: () => setTab('users'), children: "Users" }))] }), _jsx("div", { className: "flex-1" }), profile && (_jsx("span", { className: "text-sm font-sans text-text-muted", children: profile.name })), _jsx("button", { onClick: signOut, className: "text-sm font-sans text-text-muted hover:text-cosmos-black transition-colors", children: "Sign out" })] }), _jsxs("main", { className: "flex-1 px-6 py-8 max-w-5xl w-full mx-auto", children: [tab === 'clients' && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "flex items-center justify-between mb-8", children: [_jsx("h1", { className: "font-serif text-2xl font-medium text-cosmos-black", children: "Clients" }), !usingMock && (_jsx("button", { onClick: openCreate, className: "text-sm font-sans font-semibold border-2 border-cosmos-black px-4 py-2 rounded-sm bg-bg text-cosmos-black hover:bg-cosmos-black hover:text-clear-white transition-colors", style: { boxShadow: '4px 4px 0 #161616' }, children: "+ New client" }))] }), error && _jsx("p", { className: "text-sm font-sans text-signal-error mb-6", children: error }), loading ? (_jsx("div", { className: "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4", children: [1, 2, 3].map(i => (_jsx("div", { className: "h-44 bg-surface-sunken border border-border rounded-sm animate-pulse" }, i))) })) : clients.length === 0 ? (_jsxs("div", { className: "py-20 text-center", children: [_jsx("p", { className: "font-serif text-lg font-medium text-cosmos-black mb-2", children: "No clients yet" }), _jsx("p", { className: "font-sans text-sm text-text-muted mb-6", children: "Create your first client to get started." }), !usingMock && (_jsx("button", { onClick: openCreate, className: "text-sm font-sans font-semibold border-2 border-cosmos-black px-6 py-2.5 rounded-sm hover:bg-cosmos-black hover:text-clear-white transition-colors", children: "+ New client" }))] })) : (_jsx("div", { className: "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4", children: clients.map(client => (_jsx(AdminClientCard, { client: client, onNavigate: () => client.slug && navigate(`/${client.slug}`), onEdit: () => openEdit(client) }, client.id))) }))] })), tab === 'users' && isAdmin && (_jsxs(_Fragment, { children: [_jsx("div", { className: "flex items-center justify-between mb-8", children: _jsx("h1", { className: "font-serif text-2xl font-medium text-cosmos-black", children: "Users" }) }), _jsx(UsersView, { isAdmin: isAdmin })] }))] }), drawerOpen && (_jsx(ClientDrawer, { editing: editingClient, onClose: closeDrawer, onSaved: handleSaved }))] }));
}
// ── Editor router — redirect to sole client if only one exists ─
function EditorRouter() {
    const navigate = useNavigate();
    const { clients, loading } = useClients();
    useEffect(() => {
        if (loading)
            return;
        if (clients.length === 1 && clients[0].slug) {
            navigate(`/${clients[0].slug}`, { replace: true });
        }
    }, [clients, loading]);
    // Still loading, or about to redirect — show blank while transitioning
    if (loading || clients.length === 1) {
        return (_jsx("div", { className: "min-h-screen flex items-center justify-center bg-bg", children: _jsx("span", { className: "text-sm font-sans text-text-muted", children: "Loading\u2026" }) }));
    }
    return _jsx(AdminDashboard, { isAdmin: false });
}
// ── Main page ─────────────────────────────────────────────────
export default function AdminLandingPage() {
    const configured = isConfigured();
    const { session, profile, loading, signOut } = useAuth();
    if (!configured)
        return _jsx(AdminDashboard, { isAdmin: true });
    if (loading) {
        return (_jsx("div", { className: "min-h-screen flex items-center justify-center bg-bg", children: _jsx("span", { className: "text-sm font-sans text-text-muted", children: "Loading\u2026" }) }));
    }
    if (!session)
        return _jsx(AdminSignIn, {});
    if (profile?.role === 'admin')
        return _jsx(AdminDashboard, { isAdmin: true });
    if (profile?.role === 'editor')
        return _jsx(EditorRouter, {});
    if (profile) {
        return (_jsxs("div", { className: "min-h-screen flex flex-col items-center justify-center bg-bg px-4 text-center", children: [_jsx(DCMark, { size: "lg" }), _jsx("h1", { className: "font-serif text-2xl font-medium text-cosmos-black mt-6 mb-2", children: "Staff access only" }), _jsx("p", { className: "font-sans text-sm text-text-muted mb-6 max-w-xs", children: "Your account doesn't have staff privileges. Use your client portal link to access your workspace." }), _jsx("button", { onClick: signOut, className: "px-6 py-2.5 text-sm font-sans font-semibold border-2 border-cosmos-black rounded-sm hover:bg-cosmos-black hover:text-clear-white transition-colors", children: "Sign out" })] }));
    }
    // session exists but profile still resolving
    return (_jsx("div", { className: "min-h-screen flex items-center justify-center bg-bg", children: _jsx("span", { className: "text-sm font-sans text-text-muted", children: "Loading\u2026" }) }));
}
