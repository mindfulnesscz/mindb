import { create } from 'zustand';
import type { Environment } from '../services/environmentService';

interface EnvironmentStore {
  environments: Environment[];
  activeEnvId:  string | null;
  setEnvironments: (environments: Environment[]) => void;
  setActiveEnvId:  (id: string | null) => void;
}

export const useEnvironmentStore = create<EnvironmentStore>((set) => ({
  environments: [],
  activeEnvId:  null,
  setEnvironments: (environments) => set({ environments }),
  setActiveEnvId:  (activeEnvId)  => set({ activeEnvId }),
}));

export function activeEnvironment(): Environment | null {
  const { environments, activeEnvId } = useEnvironmentStore.getState();
  return environments.find(e => e.id === activeEnvId) ?? null;
}
