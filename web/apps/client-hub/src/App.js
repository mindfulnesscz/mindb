import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { useRole } from './context/RoleContext';
import { isConfigured } from './lib/supabase';
import AssetDetailPage from './features/gallery/AssetDetailPage';
import AdminLandingPage from './features/admin/AdminLandingPage';
import ClientPortalPage from './features/portal/ClientPortalPage';
import SettingsView from './features/settings/SettingsView';
// ── Standalone settings page ──────────────────────────────────
function SettingsPage() {
    const navigate = useNavigate();
    const location = useLocation();
    const { signOut } = useAuth();
    const { user, role } = useRole();
    // Figure out where "back" goes: the referring client portal or admin home
    const backPath = location.state?.from ?? '/';
    return (_jsxs("div", { className: "flex flex-col min-h-screen bg-bg", children: [_jsxs("header", { className: "flex items-center h-11 px-5 border-b border-border bg-surface shrink-0", children: [_jsxs("button", { onClick: () => navigate('/'), className: "flex items-center gap-2 mr-6 hover:opacity-70 transition-opacity", children: [_jsx("div", { className: "w-6 h-6 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center", children: _jsx("span", { className: "text-clear-white text-[10px] font-bold font-sans leading-none", children: "C" }) }), _jsx("span", { className: "font-sans text-xs font-bold tracking-[0.14em] uppercase text-cosmos-black", children: "DC HUB" })] }), _jsxs("nav", { className: "flex items-center gap-1 flex-1", children: [_jsx("button", { onClick: () => navigate(backPath), className: "px-3 py-1 text-sm font-sans text-text-muted hover:text-cosmos-black rounded-sm transition-colors", children: "\u2190 Back" }), _jsx("span", { className: "px-3 py-1 text-sm font-sans font-medium text-cosmos-black", children: "Settings" })] }), _jsxs("div", { className: "flex items-center gap-2 mr-3", children: [_jsx("div", { className: "w-7 h-7 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center", children: _jsx("span", { className: "text-clear-white text-[10px] font-bold font-sans", children: user.initials }) }), _jsxs("div", { className: "hidden sm:flex flex-col items-end leading-none", children: [_jsx("span", { className: "text-sm font-sans font-medium text-cosmos-black", children: user.name }), _jsx("span", { className: "text-[10px] font-sans font-bold uppercase tracking-label text-text-muted", children: role })] })] }), _jsx("button", { onClick: signOut, className: "text-[11px] font-sans text-text-muted hover:text-cosmos-black transition-colors border border-border rounded-sm px-2 py-1", children: "Sign out" })] }), _jsx("main", { className: "flex-1 overflow-y-auto", children: _jsx(SettingsView, {}) })] }));
}
// ── App ───────────────────────────────────────────────────────
export default function App() {
    const { loading } = useAuth();
    const configured = isConfigured();
    if (configured && loading) {
        return (_jsx("div", { className: "flex items-center justify-center min-h-full bg-bg", children: _jsx("span", { className: "text-sm font-sans text-text-muted", children: "Loading\u2026" }) }));
    }
    return (_jsxs(Routes, { children: [_jsx(Route, { index: true, element: _jsx(AdminLandingPage, {}) }), _jsx(Route, { path: "settings", element: _jsx(SettingsPage, {}) }), _jsx(Route, { path: "share/:id", element: _jsx(AssetDetailPage, {}) }), _jsx(Route, { path: ":slug", element: _jsx(ClientPortalPage, {}) })] }));
}
