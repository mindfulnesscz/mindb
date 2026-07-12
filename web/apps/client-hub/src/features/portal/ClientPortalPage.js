import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../context/AuthContext';
import { useRole } from '../../context/RoleContext';
import { useClients } from '../../hooks/useClients';
import { canSwitchClient } from '@dc-hub/asset-library';
import SignInModal from '../auth/SignInModal';
import GalleryView from '../gallery/GalleryView';
// ── DC-branded 404 ────────────────────────────────────────────
function NotFoundPage() {
    return (_jsxs("div", { className: "min-h-screen flex flex-col items-center justify-center bg-bg px-4 text-center", children: [_jsx("div", { className: "w-14 h-14 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center mb-6", style: { boxShadow: '4px 4px 0 #161616' }, children: _jsx("span", { className: "text-clear-white text-lg font-bold font-sans leading-none", children: "C" }) }), _jsx("p", { className: "font-sans text-[10px] font-bold tracking-[0.14em] uppercase text-text-muted mb-6", children: "DC HUB" }), _jsx("h1", { className: "font-serif text-4xl font-medium text-cosmos-black mb-3", children: "404" }), _jsx("p", { className: "font-sans text-sm text-text-muted mb-1", children: "This portal doesn't exist." }), _jsx("p", { className: "text-[11px] font-sans text-text-subtle", children: "Check the URL or contact DC Hub for your access link." })] }));
}
// ── Client badge (pre-login welcome screen) ───────────────────
function Badge({ client }) {
    if (client.logo_url) {
        return (_jsx("img", { src: client.logo_url, alt: client.name, className: "w-20 h-20 rounded-[28%_38%] object-cover" }));
    }
    return (_jsx("div", { className: "w-20 h-20 rounded-[28%_38%] flex items-center justify-center text-2xl font-bold font-sans text-clear-white", style: { backgroundColor: client.accent }, children: client.initials }));
}
// ── Admin / editor full app header ────────────────────────────
function AdminAppHeader({ slug }) {
    const navigate = useNavigate();
    const location = useLocation();
    const { signOut } = useAuth();
    const { role, user, activeClient, setActiveClient } = useRole();
    const { clients } = useClients();
    const navItems = [
        { label: 'Gallery', path: `/${slug}` },
        { label: 'Clients', path: '/' },
        { label: 'Settings', path: '/settings' },
    ];
    function isActive(path) {
        if (path === `/${slug}`)
            return location.pathname === `/${slug}`;
        return location.pathname === path;
    }
    return (_jsxs("header", { className: "flex items-center h-11 px-5 border-b border-border bg-surface shrink-0", children: [_jsxs("button", { onClick: () => navigate('/'), className: "flex items-center gap-2 mr-6 hover:opacity-70 transition-opacity", children: [_jsx("div", { className: "w-6 h-6 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center", children: _jsx("span", { className: "text-clear-white text-[10px] font-bold font-sans leading-none", children: "C" }) }), _jsx("span", { className: "font-sans text-xs font-bold tracking-[0.14em] uppercase text-cosmos-black", children: "DC HUB" })] }), _jsx("nav", { className: "flex items-center gap-1 flex-1", children: navItems.map(item => (_jsx("button", { onClick: () => navigate(item.path), className: `px-3 py-1 text-sm font-sans rounded-sm transition-colors duration-fast ${isActive(item.path)
                        ? 'text-cosmos-black font-medium'
                        : 'text-text-muted hover:text-cosmos-black'}`, children: item.label }, item.path))) }), canSwitchClient(role) && activeClient && (_jsxs("div", { className: "relative flex items-center gap-2 border border-border rounded-sm px-2 py-1 mr-3", children: [_jsx("span", { className: "text-[10px] font-sans font-bold uppercase tracking-label text-text-muted", children: "Client" }), _jsx("span", { className: "text-sm font-sans text-cosmos-black", children: activeClient.name }), _jsx("div", { className: "w-5 h-5 rounded-[28%_38%] flex items-center justify-center text-[8px] font-bold font-sans text-clear-white", style: { backgroundColor: activeClient.accent }, children: activeClient.initials }), _jsx("select", { className: "absolute inset-0 opacity-0 cursor-pointer w-full", value: activeClient.id, onChange: e => {
                            const c = clients.find(c => c.id === e.target.value);
                            if (c) {
                                setActiveClient(c);
                                if (c.slug)
                                    navigate(`/${c.slug}`);
                            }
                        }, "aria-label": "Switch client", children: clients.map(c => (_jsx("option", { value: c.id, children: c.name }, c.id))) })] })), _jsxs("div", { className: "flex items-center gap-2 mr-3", children: [_jsx("div", { className: "w-7 h-7 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center", children: _jsx("span", { className: "text-clear-white text-[10px] font-bold font-sans", children: user.initials }) }), _jsxs("div", { className: "hidden sm:flex flex-col items-end leading-none", children: [_jsx("span", { className: "text-sm font-sans font-medium text-cosmos-black", children: user.name }), _jsx("span", { className: "text-[10px] font-sans font-bold uppercase tracking-label text-text-muted", children: role })] })] }), _jsx("button", { onClick: signOut, className: "text-[11px] font-sans text-text-muted hover:text-cosmos-black transition-colors border border-border rounded-sm px-2 py-1", children: "Sign out" })] }));
}
// ── Simple portal header (client / public users) ──────────────
function PortalHeader({ client }) {
    const { profile, signOut } = useAuth();
    return (_jsxs("header", { className: "flex items-center gap-3 px-5 py-3 border-b border-border bg-surface shrink-0", children: [_jsxs("div", { className: "flex items-center gap-2", children: [client.logo_url ? (_jsx("img", { src: client.logo_url, alt: client.name, className: "w-7 h-7 rounded-[28%_38%] object-cover" })) : (_jsx("div", { className: "w-7 h-7 rounded-[28%_38%] flex items-center justify-center text-[10px] font-bold font-sans text-clear-white", style: { backgroundColor: client.accent }, children: client.initials })), _jsx("span", { className: "font-sans text-sm font-semibold text-cosmos-black", children: client.name })] }), _jsx("div", { className: "flex-1" }), profile && (_jsx("span", { className: "text-sm font-sans text-text-muted hidden sm:block", children: profile.name })), _jsx("button", { onClick: signOut, className: "text-sm font-sans text-text-muted hover:text-cosmos-black transition-colors", children: "Sign out" })] }));
}
// ── Main page ─────────────────────────────────────────────────
export default function ClientPortalPage() {
    const { slug } = useParams();
    const { session } = useAuth();
    const { role, setActiveClient } = useRole();
    const [client, setClient] = useState(null);
    const [missing, setMissing] = useState(false);
    const [showModal, setShowModal] = useState(false);
    const [linkError, setLinkError] = useState(null);
    // Detect auth errors Supabase puts in the URL hash (e.g. expired link)
    useEffect(() => {
        const hash = window.location.hash;
        if (!hash.includes('error='))
            return;
        const params = new URLSearchParams(hash.slice(1));
        const desc = params.get('error_description');
        if (desc)
            setLinkError(desc.replace(/\+/g, ' '));
        window.history.replaceState(null, '', window.location.pathname);
    }, []);
    // Fetch client by slug — works unauthenticated via security definer RPC
    useEffect(() => {
        if (!slug || !supabase) {
            setMissing(true);
            return;
        }
        supabase
            .rpc('get_client_portal', { p_slug: slug })
            .then(({ data, error }) => {
            if (error || !data || data.length === 0) {
                setMissing(true);
            }
            else {
                setClient(data[0]);
            }
        });
    }, [slug]);
    // Sync activeClient in RoleContext so GalleryView filters to this client
    useEffect(() => {
        if (!client)
            return;
        const roleClient = {
            id: client.id,
            name: client.name,
            accent: client.accent,
            initials: client.initials,
            logoUrl: client.logo_url ?? undefined,
            portalBg: client.portal_bg ?? undefined,
        };
        setActiveClient(roleClient);
    }, [client?.id]);
    if (missing)
        return _jsx(NotFoundPage, {});
    if (!client)
        return _jsx("div", { className: "min-h-screen bg-bg" });
    // ── Not logged in: branded welcome ────────────────────────
    if (!session) {
        const isBgImage = client.portal_bg?.startsWith('http') || client.portal_bg?.startsWith('/');
        const bgStyle = isBgImage
            ? { backgroundImage: `url(${client.portal_bg})`, backgroundSize: 'cover', backgroundPosition: 'center' }
            : { backgroundColor: client.portal_bg || client.accent + '18' };
        return (_jsxs("div", { className: "min-h-screen flex flex-col", style: bgStyle, children: [_jsxs("div", { className: "flex items-center gap-2 px-6 py-4", children: [_jsx("div", { className: "w-5 h-5 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center", children: _jsx("span", { className: "text-clear-white text-[9px] font-bold font-sans leading-none", children: "C" }) }), _jsx("span", { className: "font-sans text-[10px] font-bold tracking-[0.14em] uppercase text-cosmos-black opacity-60", children: "DC HUB" })] }), _jsx("div", { className: "flex-1 flex items-center justify-center px-6", children: _jsxs("div", { className: "text-center", children: [_jsx("div", { className: "flex justify-center mb-6", children: _jsx(Badge, { client: client }) }), _jsx("h1", { className: "font-serif text-3xl font-medium text-cosmos-black mb-2", children: client.name }), _jsx("p", { className: "font-sans text-sm text-text-muted mb-10", children: "Asset portal \u2014 request access or sign in below." }), _jsx("button", { onClick: () => { setShowModal(true); setLinkError(null); }, className: "px-8 py-3 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm hover:bg-ink-800 transition-colors", style: { boxShadow: '4px 4px 0 #161616' }, children: "Sign in / Request access" }), linkError && (_jsxs("p", { className: "mt-6 text-sm font-sans text-signal-error", children: [linkError, " \u2014 please request a new link."] }))] }) }), showModal && (_jsx(SignInModal, { redirectTo: window.location.href, clientId: client.id, onClose: () => setShowModal(false) }))] }));
    }
    // ── Logged in: full admin nav for staff, simple header for clients ──
    const isStaff = role === 'admin' || role === 'editor';
    return (_jsxs("div", { className: "flex flex-col h-screen", children: [isStaff
                ? _jsx(AdminAppHeader, { slug: slug })
                : _jsx(PortalHeader, { client: client }), _jsx("div", { className: "flex-1 overflow-hidden", children: _jsx(GalleryView, {}) })] }));
}
