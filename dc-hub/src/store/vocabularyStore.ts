import { create } from 'zustand';
import type { VocabTag, VocabularyData } from '../domain/vocabulary';

interface VocabularyStore {
  data:     VocabularyData | null;
  loading:  boolean;
  setData:  (d: VocabularyData) => void;
  addTag:   (tag: VocabTag) => void;
  updateTag:(index: number, tag: VocabTag) => void;
  deleteTag:(index: number) => void;
}

export const useVocabularyStore = create<VocabularyStore>((set) => ({
  data:    null,
  loading: true,

  setData: (d) => set({ data: d, loading: false }),

  addTag: (tag) =>
    set(state => {
      if (!state.data) return state;
      return { data: { ...state.data, tags: [...state.data.tags, tag] } };
    }),

  updateTag: (index, tag) =>
    set(state => {
      if (!state.data) return state;
      const tags = [...state.data.tags];
      tags[index] = tag;
      return { data: { ...state.data, tags } };
    }),

  deleteTag: (index) =>
    set(state => {
      if (!state.data) return state;
      const tags = state.data.tags.filter((_, i) => i !== index);
      return { data: { ...state.data, tags } };
    }),
}));
