import { describe, it, expect } from 'vitest';
import { groupAssets } from './assetGrouping';

const OUT = 'OUT';

describe('groupAssets', () => {
  it('keeps same-named files in different packages apart', () => {
    // Real case: Mucha Family has two "Deda Energie" packages, each holding plyn.pdf and
    // elektrika.pdf. Keyed by bare stem, the second package overwrote the first and one
    // package's assets vanished from the sync entirely.
    const a = '/src/Deda Energie __e0b29f18/OUT/plyn.pdf';
    const b = '/src/Deda Energie __907d6268/OUT/plyn.pdf';

    const { singles } = groupAssets([a, b], OUT);

    expect(singles).toHaveLength(2);
    expect(singles.map(s => s.packageDir).sort()).toEqual([
      '/src/Deda Energie __907d6268',
      '/src/Deda Energie __e0b29f18',
    ]);
    expect(new Set(singles.map(s => s.absPath))).toEqual(new Set([a, b]));
  });

  it('keeps same-named gallery folders in different packages apart', () => {
    // Real case: four ESS packages each contain an `Old/` gallery.
    const paths = [
      '/src/02 Dip Paint __b4cc3f38/OUT/Old/a.jpg',
      '/src/03 E-Coating __e6ce4ea2/OUT/Old/b.jpg',
      '/src/05 Sealing __ffff12e2/OUT/Old/c.jpg',
    ];

    const { galleries } = groupAssets(paths, OUT);

    expect(galleries).toHaveLength(3);
    expect(galleries.every(g => g.name === 'Old')).toBe(true);
    expect(new Set(galleries.map(g => g.packageDir)).size).toBe(3);
    expect(galleries.every(g => g.children.length === 1)).toBe(true);
  });

  it('groups several files of one gallery under a single group', () => {
    const dir = '/src/Shoot __aaaa1111/OUT/(PRD)(Gll) Studios';
    const { galleries, singles } = groupAssets(
      [`${dir}/01.jpeg`, `${dir}/02.jpeg`, `${dir}/03.jpeg`], OUT,
    );

    expect(singles).toHaveLength(0);
    expect(galleries).toHaveLength(1);
    expect(galleries[0].name).toBe('(PRD)(Gll) Studios');
    expect(galleries[0].children.map(c => c.stem).sort()).toEqual(['01', '02', '03']);
  });

  it('treats nested gallery paths as distinct galleries and keeps the full path as the name', () => {
    const pkg = '/src/Set __bbbb2222/OUT';
    const { galleries } = groupAssets(
      [`${pkg}/Galleries/Selected/a.jpg`, `${pkg}/Galleries/All/a.jpg`], OUT,
    );

    expect(galleries.map(g => g.name).sort()).toEqual(['Galleries/All', 'Galleries/Selected']);
    // Children carry the leaf stem — the folder path must not leak into it.
    expect(galleries.every(g => g.children.every(c => !c.stem.includes('/')))).toBe(true);
  });

  it('reports files with no OUT ancestor instead of inventing a package', () => {
    const { singles, galleries, unpackaged } = groupAssets(
      ['/src/Loose Folder/stray.pdf', '/src/Pkg __cccc3333/OUT/real.pdf'], OUT,
    );

    expect(unpackaged).toEqual(['/src/Loose Folder/stray.pdf']);
    expect(singles).toHaveLength(1);
    expect(singles[0].packageDir).toBe('/src/Pkg __cccc3333');
    expect(galleries).toHaveLength(0);
  });

  it('matches a workflow-prefixed OUT folder and the plain form alike', () => {
    const { singles } = groupAssets(
      ['/src/A __dddd4444/[03] OUT/x.pdf', '/src/B __eeee5555/OUT/y.pdf'], '[03] OUT',
    );

    expect(singles.map(s => s.packageDir).sort()).toEqual([
      '/src/A __dddd4444', '/src/B __eeee5555',
    ]);
  });

  it('picks the deepest OUT when a package sits inside another tree', () => {
    const { singles } = groupAssets(['/src/OUT/Nested __ffff6666/OUT/z.pdf'], OUT);

    expect(singles).toHaveLength(1);
    expect(singles[0].packageDir).toBe('/src/OUT/Nested __ffff6666');
  });
});
