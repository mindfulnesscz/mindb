import { create } from 'zustand';

export type NavDest = 'pipeline' | 'vocabulary' | 'settings';

interface AppStore {
  active: NavDest;
  navigate: (dest: NavDest) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  active: 'pipeline',
  navigate: (dest) => set({ active: dest }),
}));
