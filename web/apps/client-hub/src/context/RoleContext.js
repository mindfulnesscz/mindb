import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useContext, useState, useEffect } from 'react';
import { MOCK_CLIENTS } from '@dc-hub/asset-library';
import { supabase, isConfigured } from '../lib/supabase';
import { toClient } from '../services/clientService';
import { useAuth } from './AuthContext';
const RoleContext = createContext(null);
const DEMO_USERS = {
    public: { name: 'Guest', initials: 'G' },
    member: { name: 'Jana K.', initials: 'JK' },
    editor: { name: 'Petr Mucha', initials: 'PM' },
    admin: { name: 'Petr Mucha', initials: 'PM' },
};
export function RoleProvider({ children }) {
    const configured = isConfigured();
    const { profile } = useAuth();
    const [demoRole, setDemoRole] = useState('editor');
    const [activeClient, setActiveClient] = useState(configured ? null : MOCK_CLIENTS[0]);
    const role = configured ? (profile?.role ?? 'public') : demoRole;
    const user = configured && profile
        ? { name: profile.name, initials: profile.initials }
        : DEMO_USERS[demoRole];
    // Auto-set activeClient from profile when a client user logs in
    useEffect(() => {
        if (!configured || !profile?.client_id || !supabase)
            return;
        supabase
            .from('clients')
            .select('*')
            .eq('id', profile.client_id)
            .single()
            .then(({ data }) => {
            if (data)
                setActiveClient(toClient(data));
        });
    }, [profile?.client_id]);
    return (_jsx(RoleContext.Provider, { value: {
            role,
            setRole: configured ? () => { } : setDemoRole,
            activeClient,
            setActiveClient,
            user,
        }, children: children }));
}
export function useRole() {
    const ctx = useContext(RoleContext);
    if (!ctx)
        throw new Error('useRole must be used inside RoleProvider');
    return ctx;
}
