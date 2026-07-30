/* Taxonomy key derivation — the stable keys tags are addressed by.
 *
 * These were private and untested inside the 1,438-line supabaseService. They matter because a
 * key is an ADDRESS, not a label: it is the Obsidian tag on export and the node identity in the
 * portal's filter tree. The portal creates parent groups, the desktop app publishes leaves under
 * them, and both must derive the same key for the same tag — otherwise one hierarchy silently
 * becomes two and a client's filters lose half their assets.
 */

import { describe, it, expect } from 'vitest';
import { slugifyKeyPart, parentKeyForLeaf } from './taxonomyKeys';

describe('slugifyKeyPart', () => {
  it('lowercases and hyphenates whitespace', () => {
    expect(slugifyKeyPart('Product Launch')).toBe('product-launch');
    expect(slugifyKeyPart('SALES')).toBe('sales');
  });

  it('collapses runs of whitespace into a single hyphen', () => {
    expect(slugifyKeyPart('Product    Launch')).toBe('product-launch');
    expect(slugifyKeyPart('Product\tLaunch')).toBe('product-launch');
  });

  it('trims before slugifying, so padding never becomes a leading hyphen', () => {
    expect(slugifyKeyPart('  Product  ')).toBe('product');
  });

  it('keeps dot, underscore and hyphen — the key separators', () => {
    expect(slugifyKeyPart('entity.sub_group-one')).toBe('entity.sub_group-one');
  });

  it('strips everything else, including the emoji and punctuation real tag names carry', () => {
    expect(slugifyKeyPart('📦 Handoff')).toBe('-handoff');
    expect(slugifyKeyPart("Client's Assets!")).toBe('clients-assets');
    expect(slugifyKeyPart('A & B (draft)')).toBe('a--b-draft');
  });

  it('drops accented characters rather than transliterating them', () => {
    // ⚠ Worth knowing before relying on this for Czech/Slovak client names: "Šumava" does not
    // become "sumava", it becomes "umava". Locked so the behaviour is a decision, not a surprise.
    expect(slugifyKeyPart('Šumava')).toBe('umava');
    expect(slugifyKeyPart('Deda Energie')).toBe('deda-energie');
  });

  it('can return an empty string when every character is stripped', () => {
    expect(slugifyKeyPart('🎉')).toBe('');
    expect(slugifyKeyPart('   ')).toBe('');
  });
});

describe('parentKeyForLeaf', () => {
  it('returns null for an ungrouped leaf — there is no parent to attach to', () => {
    expect(parentKeyForLeaf({ key: 'entity.product', slot: 'entity', parentGroup: null })).toBeNull();
  });

  it('treats a blank or whitespace-only group as ungrouped', () => {
    expect(parentKeyForLeaf({ key: 'entity.product', slot: 'entity', parentGroup: '' })).toBeNull();
    expect(parentKeyForLeaf({ key: 'entity.product', slot: 'entity', parentGroup: '   ' })).toBeNull();
  });

  it('prefers the key hierarchy: strips the last segment when the key already nests', () => {
    // The key is authoritative when it carries structure — the group NAME is only a fallback,
    // so renaming a group in the portal does not re-parent leaves that already have a path.
    expect(parentKeyForLeaf({ key: 'entity.products.launch', slot: 'entity', parentGroup: 'Products' }))
      .toBe('entity.products');
    expect(parentKeyForLeaf({ key: 'a.b.c.d', slot: 'entity', parentGroup: 'Anything' })).toBe('a.b.c');
  });

  it('invents `slot.slug` from the group name when the key is flat', () => {
    expect(parentKeyForLeaf({ key: 'product', slot: 'entity', parentGroup: 'Core Products' }))
      .toBe('entity.core-products');
    expect(parentKeyForLeaf({ key: 'slides', slot: 'format', parentGroup: 'Decks' }))
      .toBe('format.decks');
  });

  it('scopes the invented key by slot, so identically-named groups never collide', () => {
    // "Product" can legitimately be a group in two dimensions; the keys must stay distinct.
    const entity = parentKeyForLeaf({ key: 'a', slot: 'entity', parentGroup: 'Product' });
    const format = parentKeyForLeaf({ key: 'b', slot: 'format', parentGroup: 'Product' });
    expect(entity).toBe('entity.product');
    expect(format).toBe('format.product');
    expect(entity).not.toBe(format);
  });

  it('ignores empty key segments when deciding whether the key nests', () => {
    // "entity..product" has two real parts, so the key path still wins.
    expect(parentKeyForLeaf({ key: 'entity..product', slot: 'entity', parentGroup: 'G' }))
      .toBe('entity');
  });

  it('falls back to the group name when the key is empty', () => {
    expect(parentKeyForLeaf({ key: '', slot: 'angle', parentGroup: 'Purpose' })).toBe('angle.purpose');
  });
});
