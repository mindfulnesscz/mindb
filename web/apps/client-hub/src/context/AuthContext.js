import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useContext, useEffect, useState } from 'react';
import { supabase, isConfigured } from '../lib/supabase';
const AuthContext = createContext(null);
export function AuthProvider({ children }) {
    const configured = isConfigured();
    const [session, setSession] = useState(null);
    const [profile, setProfile] = useState(null);
    const [loading, setLoading] = useState(configured);
    useEffect(() => {
        if (!supabase || !configured) {
            setLoading(false);
            return;
        }
        supabase.auth.getSession().then(({ data: { session } }) => {
            setSession(session);
            if (session)
                fetchProfile(session.user.id);
            else
                setLoading(false);
        });
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            if (session)
                fetchProfile(session.user.id);
            else {
                setProfile(null);
                setLoading(false);
            }
        });
        return () => subscription.unsubscribe();
    }, []);
    async function fetchProfile(userId) {
        if (!supabase)
            return;
        const { data } = await supabase.from('profiles').select('*').eq('id', userId).single();
        setProfile(data);
        setLoading(false);
    }
    async function checkEmail(email) {
        if (!supabase)
            return 'unknown';
        const { data, error } = await supabase.rpc('check_email_auth', { p_email: email });
        if (error)
            return 'unknown';
        return data ?? 'unknown';
    }
    async function sendMagicLink(email, userData, redirectTo, clientId) {
        if (!supabase)
            return 'Supabase not configured';
        const { error } = await supabase.auth.signInWithOtp({
            email,
            options: {
                emailRedirectTo: redirectTo ?? window.location.origin,
                data: { ...userData, ...(clientId ? { client_id: clientId } : {}) },
            },
        });
        return error?.message ?? null;
    }
    async function signOut() {
        await supabase?.auth.signOut();
    }
    return (_jsx(AuthContext.Provider, { value: { session, profile, loading, checkEmail, sendMagicLink, signOut }, children: children }));
}
export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx)
        throw new Error('useAuth must be used inside AuthProvider');
    return ctx;
}
