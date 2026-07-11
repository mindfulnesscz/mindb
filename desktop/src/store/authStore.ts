import { create } from 'zustand';
import type { AuthProfile, AuthServerConfig } from '../services/authService';

/** booting: reading config/session · unconfigured: no auth server set ·
 *  signedOut: needs login · denied: authenticated but role not allowed ·
 *  signedIn: gate open */
export type AuthStatus = 'booting' | 'unconfigured' | 'signedOut' | 'denied' | 'signedIn';

interface AuthStore {
  status:  AuthStatus;
  server:  AuthServerConfig | null;
  profile: AuthProfile | null;
  setStatus:  (status: AuthStatus) => void;
  setServer:  (server: AuthServerConfig | null) => void;
  setProfile: (profile: AuthProfile | null) => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  status:  'booting',
  server:  null,
  profile: null,
  setStatus:  (status)  => set({ status }),
  setServer:  (server)  => set({ server }),
  setProfile: (profile) => set({ profile }),
}));
