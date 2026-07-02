import { create } from 'zustand';
import type { Client } from '../domain/client';

interface ClientStore {
  clients:        Client[];
  activeClientId: string | null;
  setClients:       (clients: Client[]) => void;
  setActiveClientId:(id: string | null) => void;
  addClient:        (client: Client) => void;
  updateClient:     (id: string, patch: Partial<Client>) => void;
  deleteClient:     (id: string) => void;
}

export const useClientStore = create<ClientStore>((set) => ({
  clients:        [],
  activeClientId: null,

  setClients:        (clients)       => set({ clients }),
  setActiveClientId: (activeClientId) => set({ activeClientId }),

  addClient: (client) =>
    set(s => ({ clients: [...s.clients, client] })),

  updateClient: (id, patch) =>
    set(s => ({ clients: s.clients.map(c => c.id === id ? { ...c, ...patch } : c) })),

  deleteClient: (id) =>
    set(s => ({
      clients:        s.clients.filter(c => c.id !== id),
      activeClientId: s.activeClientId === id ? null : s.activeClientId,
    })),
}));
