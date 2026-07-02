import { create } from 'zustand';
import type { VocabTag, VocabularyData } from '../domain/vocabulary';
import { getSeedVocabulary } from '../services/vocabService';

const EMPTY_VOCAB: VocabularyData = {
  _schema_version: '2.1.0',
  _comment: 'DC Hub vocabulary',
  tags: [],
};

interface VocabularyStore {
  data:      VocabularyData | null;
  loading:   boolean;
  setData:   (d: VocabularyData) => void;
  addTag:    (tag: VocabTag) => void;
  updateTag: (index: number, tag: VocabTag) => void;
  deleteTag: (index: number) => void;
}

function ensureData(state: VocabularyStore): VocabularyData {
  return state.data ?? { ...EMPTY_VOCAB, tags: [] };
}

export const useVocabularyStore = create<VocabularyStore>((set) => ({
  data:    getSeedVocabulary(),
  loading: true,

  setData: (d) => set({ data: d, loading: false }),

  addTag: (tag) =>
    set(state => {
      const current = ensureData(state);
      return { data: { ...current, tags: [...current.tags, tag] }, loading: false };
    }),

  updateTag: (index, tag) =>
    set(state => {
      const current = ensureData(state);
      const tags = [...current.tags];
      tags[index] = tag;
      return { data: { ...current, tags } };
    }),

  deleteTag: (index) =>
    set(state => {
      const current = ensureData(state);
      const tags = current.tags.filter((_, i) => i !== index);
      return { data: { ...current, tags } };
    }),
}));
