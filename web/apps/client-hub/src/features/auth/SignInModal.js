import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
const INDUSTRY_OPTIONS = [
    'Advertising & Marketing',
    'Architecture & Design',
    'Consumer Goods',
    'E-commerce & Retail',
    'Entertainment & Media',
    'Fashion & Apparel',
    'Finance & Insurance',
    'Food & Beverage',
    'Healthcare & Pharma',
    'Hospitality & Travel',
    'Manufacturing',
    'Non-profit',
    'Real Estate',
    'Sports & Fitness',
    'Technology & Software',
    'Other',
];
function Field({ label, required, children, }) {
    return (_jsxs("div", { children: [_jsxs("label", { className: "block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5", children: [label, required && _jsx("span", { className: "text-signal-error ml-0.5", children: "*" })] }), children] }));
}
const inputCls = 'w-full text-sm font-sans border border-border rounded-sm px-3 py-2 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors';
export default function SignInModal({ redirectTo, clientId, onClose } = {}) {
    const { checkEmail, sendMagicLink } = useAuth();
    const [step, setStep] = useState('email');
    const [email, setEmail] = useState('');
    const [, setAuthType] = useState(null);
    const [error, setError] = useState('');
    // Extra fields for unknown users
    const [name, setName] = useState('');
    const [country, setCountry] = useState('');
    const [company, setCompany] = useState('');
    const [industry, setIndustry] = useState('');
    const [consent, setConsent] = useState(false);
    const emailRef = useRef(null);
    useEffect(() => { emailRef.current?.focus(); }, []);
    async function handleEmailSubmit(e) {
        e.preventDefault();
        const trimmed = email.trim().toLowerCase();
        if (!trimmed)
            return;
        setError('');
        setStep('checking');
        const type = await checkEmail(trimmed);
        setAuthType(type);
        if (type === 'unknown') {
            setStep('extra');
            return;
        }
        // Known user — send link immediately
        await doSend(trimmed, type);
    }
    async function handleExtraSubmit(e) {
        e.preventDefault();
        if (!name.trim() || !country.trim() || !company.trim() || !industry || !consent)
            return;
        setStep('sending');
        await doSend(email.trim().toLowerCase(), 'unknown', {
            name: name.trim(),
            country: country.trim(),
            company: company.trim(),
            industry,
        });
    }
    async function doSend(email, type, userData) {
        const err = await sendMagicLink(email, userData, redirectTo, clientId);
        if (err) {
            setError(err);
            setStep(type === 'unknown' ? 'extra' : 'email');
        }
        else {
            setStep('sent');
        }
    }
    const canSubmitExtra = name.trim() && country.trim() && company.trim() && industry && consent;
    return (
    // Overlay
    _jsx("div", { className: "fixed inset-0 z-50 flex items-center justify-center px-4", style: { backdropFilter: 'blur(4px)', backgroundColor: 'rgba(22,22,22,0.45)' }, onClick: e => { if (e.target === e.currentTarget && onClose)
            onClose(); }, children: _jsxs("div", { className: "w-full max-w-md bg-bg border border-cosmos-black rounded-sm overflow-hidden", style: { boxShadow: '6px 6px 0 #161616' }, children: [_jsxs("div", { className: "px-6 pt-6 pb-5 border-b border-border", children: [_jsxs("div", { className: "flex items-center gap-2 mb-4", children: [_jsx("div", { className: "w-6 h-6 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center shrink-0", children: _jsx("span", { className: "text-clear-white text-[10px] font-bold font-sans leading-none", children: "C" }) }), _jsx("span", { className: "font-sans text-xs font-bold tracking-[0.14em] uppercase text-cosmos-black", children: "DC HUB" })] }), _jsx("h1", { className: "font-serif text-xl font-medium text-cosmos-black", children: step === 'sent' ? 'Check your email' : 'Sign in' }), _jsx("p", { className: "font-sans text-sm text-text-muted mt-1", children: step === 'sent'
                                ? `We sent a magic link to ${email}`
                                : step === 'extra'
                                    ? 'Tell us a bit about yourself to get access.'
                                    : 'Enter your email to receive a magic link.' })] }), _jsxs("div", { className: "px-6 py-6", children: [step === 'sent' && (_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "flex items-start gap-3 p-4 bg-surface-sunken border border-border rounded-sm", children: [_jsx("svg", { className: "shrink-0 mt-0.5", width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5", children: _jsx("path", { d: "M2 4l6 5 6-5M2 4h12v9H2V4Z" }) }), _jsxs("p", { className: "text-sm font-sans text-cosmos-black", children: ["Click the link in your email to sign in. It expires in 1 hour.", _jsx("br", {}), _jsx("span", { className: "text-text-muted text-[11px]", children: "If you don't see it, check your spam folder." })] })] }), _jsx("button", { onClick: () => { setStep('email'); setEmail(''); setError(''); }, className: "text-[11px] font-sans text-text-muted hover:text-cosmos-black underline transition-colors", children: "Use a different email" })] })), (step === 'email' || step === 'checking') && (_jsxs("form", { onSubmit: handleEmailSubmit, className: "space-y-4", children: [_jsx(Field, { label: "Email", required: true, children: _jsx("input", { ref: emailRef, type: "email", value: email, onChange: e => setEmail(e.target.value), placeholder: "you@company.com", required: true, disabled: step === 'checking', className: inputCls }) }), error && _jsx("p", { className: "text-[11px] font-sans text-signal-error", children: error }), _jsx("button", { type: "submit", disabled: step === 'checking' || !email.trim(), className: "w-full py-2.5 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm disabled:opacity-50 hover:bg-ink-800 transition-colors", style: { boxShadow: '4px 4px 0 #161616' }, children: step === 'checking' ? 'Checking…' : 'Continue' })] })), (step === 'extra' || step === 'sending') && (_jsxs("form", { onSubmit: handleExtraSubmit, className: "space-y-4", children: [_jsxs("div", { className: "flex items-center gap-2 py-2 text-sm font-sans text-text-muted", children: [_jsx("span", { className: "font-mono", children: email }), _jsx("button", { type: "button", onClick: () => { setStep('email'); setError(''); }, className: "text-[11px] underline hover:text-cosmos-black transition-colors", children: "change" })] }), _jsx(Field, { label: "Full name", required: true, children: _jsx("input", { type: "text", value: name, onChange: e => setName(e.target.value), placeholder: "Jana Kov\u00E1\u0159ov\u00E1", required: true, autoFocus: true, className: inputCls }) }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsx(Field, { label: "Country", required: true, children: _jsx("input", { type: "text", value: country, onChange: e => setCountry(e.target.value), placeholder: "Czech Republic", required: true, className: inputCls }) }), _jsx(Field, { label: "Company", required: true, children: _jsx("input", { type: "text", value: company, onChange: e => setCompany(e.target.value), placeholder: "Acme s.r.o.", required: true, className: inputCls }) })] }), _jsx(Field, { label: "Industry", required: true, children: _jsxs("select", { value: industry, onChange: e => setIndustry(e.target.value), required: true, className: `${inputCls} cursor-pointer`, children: [_jsx("option", { value: "", children: "Select your industry\u2026" }), INDUSTRY_OPTIONS.map(o => (_jsx("option", { value: o, children: o }, o)))] }) }), _jsxs("label", { className: "flex items-start gap-3 cursor-pointer group", children: [_jsx("input", { type: "checkbox", checked: consent, onChange: e => setConsent(e.target.checked), required: true, className: "mt-0.5 shrink-0 accent-cosmos-black" }), _jsx("span", { className: "text-[11px] font-sans text-text-muted group-hover:text-cosmos-black transition-colors leading-relaxed", children: "I agree that my name, company, country, and industry will be stored to provide access to this portal. You can request deletion at any time." })] }), error && _jsx("p", { className: "text-[11px] font-sans text-signal-error", children: error }), _jsx("button", { type: "submit", disabled: step === 'sending' || !canSubmitExtra, className: "w-full py-2.5 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm disabled:opacity-50 hover:bg-ink-800 transition-colors", style: canSubmitExtra ? { boxShadow: '4px 4px 0 #161616' } : undefined, children: step === 'sending' ? 'Sending…' : 'Send magic link' })] }))] })] }) }));
}
