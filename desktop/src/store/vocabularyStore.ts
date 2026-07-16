import { create } from 'zustand';
import type { VocabTag, VocabularyData } from '../domain/vocabulary';
import { getSeedVocabulary } from '../services/vocabService';

const EMPTY_VOCAB: VocabularyData = {
  _schema_version: '4.0.0',
  _comment: 'DC Hub vocabulary',
  tags: [],
};

interface VocabularyStore {
  data:      VocabularyData | null;
  loading:   boolean;
  /** True after local add/edit/delete until Publish or Reload from portal. */
  dirty:     boolean;
  setData:   (d: VocabularyData, opts?: { dirty?: boolean }) => void;
  addTag:    (tag: VocabTag) => void;
  updateTag: (index: number, tag: VocabTag) => void;
  deleteTag: (index: number) => void;
  markClean: () => void;
}

function ensureData(state: VocabularyStore): VocabularyData {
  return state.data ?? { ...EMPTY_VOCAB, tags: [] };
}

export const useVocabularyStore = create<VocabularyStore>((set) => ({
  data:    getSeedVocabulary(),
  loading: true,
  dirty:   false,

  setData: (d, opts) => set({ data: d, loading: false, dirty: opts?.dirty ?? false }),

  markClean: () => set({ dirty: false }),

  addTag: (tag) =>
    set(state => {
      const current = ensureData(state);
      return { data: { ...current, tags: [...current.tags, tag] }, loading: false, dirty: true };
    }),

  updateTag: (index, tag) =>
    set(state => {
      const current = ensureData(state);
      const tags = [...current.tags];
      tags[index] = tag;
      return { data: { ...current, tags }, dirty: true };
    }),

  deleteTag: (index) =>
    set(state => {
      const current = ensureData(state);
      const tags = current.tags.filter((_, i) => i !== index);
      return { data: { ...current, tags }, dirty: true };
    }),
}));
