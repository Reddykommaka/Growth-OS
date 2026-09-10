/**
 * Token-system contract.
 *
 * 13-design-system.md §2: product code uses SEMANTIC tokens only, and both themes are
 * first-class. These are static assertions over the stylesheets — a token that exists only
 * in one theme, or a raw hex in a component, is a defect that is invisible until someone
 * switches theme.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = import.meta.dirname;
const tokensCss = readFileSync(join(dir, 'tokens.css'), 'utf8');
const primitivesCss = readFileSync(join(dir, '../primitives/primitives.css'), 'utf8');

/**
 * Custom-property declarations across EVERY block matching a selector.
 *
 * The tokens file deliberately has two `:root {` blocks — the primitive tier and the
 * semantic tier — so reading only the first would silently miss most of the palette.
 */
function declaredIn(css: string, selector: string): Set<string> {
  const names = new Set<string>();
  let from = 0;
  for (;;) {
    const index = css.indexOf(selector, from);
    if (index === -1) break;
    const open = css.indexOf('{', index);
    if (open === -1) break;
    let depth = 0;
    let end = css.length;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    for (const m of css.slice(open, end).matchAll(/(--[a-z0-9-]+)\s*:/g)) {
      if (m[1] !== undefined) names.add(m[1]);
    }
    from = end;
  }
  return names;
}

const SEMANTIC_PREFIXES = [
  '--surface-',
  '--text-',
  '--border-',
  '--accent',
  '--status-',
  '--shadow-',
  '--focus-',
];
/**
 * Semantic tokens carry a role name; primitives carry a numeric scale step (--accent-500,
 * --gray-100). Excluding the numeric suffix keeps the primitive palette out of the
 * theme-completeness assertions, which are about roles.
 */
const isSemantic = (name: string) =>
  SEMANTIC_PREFIXES.some((p) => name.startsWith(p)) && !/-\d+$/.test(name);

describe('theme completeness', () => {
  const light = [...declaredIn(tokensCss, ':root {')].filter(isSemantic);
  // --text-sm and friends are typography primitives that share the --text- prefix; the
  // count assertion below is about the colour roles, which comfortably exceed 20.
  const explicitDark = declaredIn(tokensCss, ":root[data-theme='dark']");

  it('defines a light palette on bare :root', () => {
    expect(light.length).toBeGreaterThan(20);
  });

  it('redefines in explicit dark every token dark actually changes', () => {
    // A token defined only inside a media or [data-theme] block is the classic theming bug:
    // it works in one theme and is undefined in the other.
    const mediaDark = declaredIn(tokensCss, ":root:not([data-theme='light'])");
    const missing = [...mediaDark].filter((t) => isSemantic(t) && !explicitDark.has(t));
    expect(
      missing,
      `only in the media query, not in [data-theme="dark"]: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('declares no colour token exclusively inside a theme block', () => {
    const baseRoot = declaredIn(tokensCss, ':root {');
    const orphans = [...explicitDark].filter((t) => isSemantic(t) && !baseRoot.has(t));
    expect(orphans, `missing from the base :root palette: ${orphans.join(', ')}`).toEqual([]);
  });

  it('sets an explicit background and colour on body', () => {
    // The host paints its own ground behind the page; a transparent body borrows it.
    expect(tokensCss).toMatch(/body\s*\{[^}]*background:\s*var\(--surface-base\)/);
    expect(tokensCss).toMatch(/body\s*\{[^}]*color:\s*var\(--text-primary\)/);
  });
});

describe('primitives use semantic tokens only', () => {
  it('contains no raw hex colours', () => {
    // A raw hex in a component is invisible in one theme and wrong in the other.
    const hexes = primitivesCss.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    expect(hexes, `raw colours found: ${hexes.join(', ')}`).toEqual([]);
  });

  it('references only defined custom properties', () => {
    const defined = new Set([...tokensCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...primitivesCss.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
    const undefinedTokens = [...used].filter((t) => t !== undefined && !defined.has(t));
    expect(undefinedTokens, `undefined tokens: ${undefinedTokens.join(', ')}`).toEqual([]);
  });

  it('uses grid-multiple spacing rather than arbitrary pixel values', () => {
    // 4px base grid (13-design-system.md §2). Sub-pixel borders and icon sizing are exempt.
    const pixelValues = [...primitivesCss.matchAll(/(?:padding|margin|gap)[^:]*:\s*([^;]+);/g)]
      .flatMap((m) => (m[1] ?? '').split(/\s+/))
      .filter((v) => /^\d+px$/.test(v))
      .filter((v) => Number.parseInt(v, 10) % 4 !== 0);
    expect(pixelValues, `off-grid spacing: ${pixelValues.join(', ')}`).toEqual([]);
  });
});

describe('typography and motion', () => {
  it('sets tabular numerals globally', () => {
    // Non-tabular figures in a metrics column is the most recognisable tell of an
    // unconsidered dashboard (13-design-system.md §2).
    expect(tokensCss).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it('uses a 13px application base rather than the 16px document default', () => {
    expect(tokensCss).toMatch(/--text-sm:\s*0\.8125rem/);
    expect(tokensCss).toMatch(/font-size:\s*var\(--text-sm\)/);
  });

  it('keeps radii small — no 16px card look', () => {
    const radii = [...tokensCss.matchAll(/--radius-(?!full)[a-z]+:\s*(\d+)px/g)].map((m) =>
      Number.parseInt(m[1] ?? '0', 10),
    );
    expect(radii.length).toBeGreaterThan(0);
    expect(Math.max(...radii)).toBeLessThanOrEqual(6);
  });

  it('honours prefers-reduced-motion', () => {
    expect(tokensCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  it('never removes focus without replacing it', () => {
    // :focus-visible sets outline:none AND a box-shadow ring. The outline reset alone would
    // leave keyboard users with no affordance at all.
    const focusBlock = /:focus-visible\s*\{([^}]*)\}/.exec(tokensCss)?.[1] ?? '';
    expect(focusBlock).toMatch(/outline:\s*none/);
    expect(focusBlock).toMatch(/box-shadow:\s*var\(--focus-ring\)/);
  });
});

describe('density', () => {
  // Quote style inside an attribute selector belongs to the formatter, not to these
  // assertions: Biome normalises to double quotes, and hard-coding either is brittle.
  const densitySelector = (name: string) => new RegExp(`\\[data-density=['"]${name}['"]\\]`);

  it('provides three density modes driven by component tokens', () => {
    for (const density of ['compact', 'default', 'comfortable']) {
      expect(tokensCss, density).toMatch(densitySelector(density));
    }
  });

  it('scales row height monotonically across densities', () => {
    const heightFor = (name: string) => {
      const match = densitySelector(name).exec(tokensCss);
      if (match?.index === undefined) return 0;
      return Number.parseInt(
        /--table-row-height:\s*(\d+)px/.exec(tokensCss.slice(match.index))?.[1] ?? '0',
        10,
      );
    };
    expect(heightFor('compact')).toBeGreaterThan(0);
    expect(heightFor('compact')).toBeLessThan(heightFor('comfortable'));
  });
});
