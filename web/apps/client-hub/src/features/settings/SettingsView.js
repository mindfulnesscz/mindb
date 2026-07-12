import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { getConfig, testConnection, reloadWithNewConfig, clearConfig, isConfigured } from '../../lib/supabase';
const NOTIF_PREFS = [
    { key: 'digest', label: 'Weekly activity digest', description: 'A weekly summary of activity on assets relevant to you.' },
    { key: 'comments', label: 'Comment notifications', description: 'Get notified when someone comments on an asset.' },
    { key: 'approvals', label: 'Approval requests', description: 'Get notified when an asset is awaiting your decision.' },
];
function Toggle({ checked, onChange }) {
    return (_jsx("button", { role: "switch", "aria-checked": checked, onClick: onChange, className: `w-9 h-5 rounded-pill relative shrink-0 transition-colors duration-base ${checked ? 'bg-cosmos-black' : 'bg-gray-300'}`, children: _jsx("span", { className: `absolute top-0.5 w-4 h-4 bg-clear-white rounded-pill transition-transform duration-base ${checked ? 'translate-x-4' : 'translate-x-0.5'}` }) }));
}
function SectionLabel({ children }) {
    return (_jsx("p", { className: "text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-4", children: children }));
}
function Card({ children, className = '' }) {
    return (_jsx("div", { className: `border border-border rounded-sm overflow-hidden ${className}`, children: children }));
}
// ── Supabase connection section ────────────────────────────────
function ConnectionSection() {
    const cfg = getConfig();
    const configured = isConfigured();
    const [url, setUrl] = useState(cfg.fromEnv ? '' : cfg.url);
    const [key, setKey] = useState('');
    const [keyVisible, setKeyVisible] = useState(false);
    const [status, setStatus] = useState('idle');
    const [errMsg, setErrMsg] = useState('');
    async function handleTest() {
        setStatus('testing');
        setErrMsg('');
        const result = await testConnection();
        setStatus(result.ok ? 'ok' : 'error');
        if (!result.ok)
            setErrMsg(result.error ?? 'Connection failed.');
    }
    function handleSave() {
        if (!url.trim() || !key.trim())
            return;
        reloadWithNewConfig(url.trim(), key.trim());
    }
    function handleDisconnect() {
        clearConfig();
        window.location.reload();
    }
    return (_jsxs("section", { className: "mb-10", children: [_jsx(SectionLabel, { children: "Workspace connection" }), _jsxs("div", { className: `flex items-center gap-2 px-4 py-3 mb-4 rounded-sm border text-sm font-sans ${configured
                    ? 'bg-surface border-border text-cosmos-black'
                    : 'bg-surface-sunken border-border text-text-muted'}`, children: [_jsx("span", { className: `w-2 h-2 rounded-full shrink-0 ${configured ? 'bg-signal-success' : 'bg-gray-300'}` }), configured
                        ? (_jsxs("span", { children: [_jsx("strong", { children: "Connected" }), " \u2014 ", cfg.fromEnv ? 'credentials loaded from environment variables' : cfg.url] }))
                        : _jsx("span", { children: "Not connected \u2014 enter your Supabase project URL and anon key below." }), configured && !cfg.fromEnv && (_jsx("button", { onClick: handleDisconnect, className: "ml-auto text-[11px] font-sans text-text-muted hover:text-cosmos-black underline transition-colors", children: "Disconnect" }))] }), !cfg.fromEnv && (_jsxs(Card, { children: [_jsxs("div", { className: "p-5 space-y-4", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5", children: "Project URL" }), _jsx("input", { type: "url", value: url, onChange: e => setUrl(e.target.value), placeholder: "https://xxxxxxxxxxxxxxxxxxxx.supabase.co", className: "w-full text-sm font-sans border border-border rounded-sm px-3 py-2 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors font-mono" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5", children: "Public API key" }), _jsxs("div", { className: "relative", children: [_jsx("input", { type: keyVisible ? 'text' : 'password', value: key, onChange: e => setKey(e.target.value), placeholder: "eyJhbGci\u2026", className: "w-full text-sm font-sans border border-border rounded-sm px-3 py-2 pr-10 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors font-mono" }), _jsx("button", { type: "button", onClick: () => setKeyVisible(v => !v), className: "absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-sans text-text-muted hover:text-cosmos-black transition-colors", children: keyVisible ? 'hide' : 'show' })] }), _jsxs("p", { className: "text-[11px] font-sans text-text-subtle mt-1", children: ["Use the ", _jsx("strong", { children: "anon / public" }), " key \u2014 not the secret service_role key. Find it in Project \u2192 Settings \u2192 API \u2192 \"anon public\"."] })] }), _jsxs("div", { className: "flex items-center gap-3 pt-1", children: [_jsx("button", { onClick: handleSave, disabled: !url.trim() || !key.trim(), className: "px-4 py-2 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm disabled:opacity-40 hover:bg-ink-800 transition-colors", style: url.trim() && key.trim() ? { boxShadow: '4px 4px 0 #161616' } : undefined, children: "Save & reload" }), _jsx("button", { onClick: handleTest, disabled: status === 'testing' || !configured, className: "px-4 py-2 text-sm font-sans border border-border rounded-sm text-cosmos-black hover:border-cosmos-black disabled:opacity-40 transition-colors", children: status === 'testing' ? 'Testing…' : 'Test connection' }), status === 'ok' && (_jsx("span", { className: "text-[11px] font-sans text-signal-success font-medium", children: "\u2713 Connected" })), status === 'error' && (_jsx("span", { className: "text-[11px] font-sans text-signal-error", children: errMsg }))] })] }), _jsx("div", { className: "border-t border-border px-5 py-3 bg-surface-sunken", children: _jsxs("p", { className: "text-[11px] font-sans text-text-muted", children: ["For production, set ", _jsx("code", { className: "font-mono bg-gray-150 px-1 rounded-chip", children: "VITE_SUPABASE_URL" }), " and", ' ', _jsx("code", { className: "font-mono bg-gray-150 px-1 rounded-chip", children: "VITE_SUPABASE_ANON_KEY" }), " as environment variables \u2014 they take precedence over the form above."] }) })] }))] }));
}
// ── Notifications section ──────────────────────────────────────
function NotificationsSection() {
    const [prefs, setPrefs] = useState({
        digest: true, comments: true, approvals: false,
    });
    return (_jsxs("section", { className: "mb-10", children: [_jsx(SectionLabel, { children: "Notifications" }), _jsx(Card, { children: NOTIF_PREFS.map((pref, i) => (_jsxs("label", { className: `flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-surface-sunken transition-colors ${i < NOTIF_PREFS.length - 1 ? 'border-b border-border' : ''}`, children: [_jsxs("div", { className: "pr-8", children: [_jsx("p", { className: "text-sm font-sans font-medium text-cosmos-black", children: pref.label }), _jsx("p", { className: "text-[11px] font-sans text-text-muted mt-0.5", children: pref.description })] }), _jsx(Toggle, { checked: prefs[pref.key], onChange: () => setPrefs(p => ({ ...p, [pref.key]: !p[pref.key] })) })] }, pref.key))) })] }));
}
// ── Main view ─────────────────────────────────────────────────
export default function SettingsView() {
    return (_jsxs("div", { className: "max-w-[600px] mx-auto px-5 py-8", children: [_jsx("h1", { className: "font-serif text-2xl font-medium text-cosmos-black tracking-tight mb-8", children: "Settings" }), _jsx(ConnectionSection, {}), _jsx(NotificationsSection, {})] }));
}
