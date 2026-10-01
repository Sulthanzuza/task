import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PILL_TINT } from '@tm/shared';

/**
 * The colour rules, enforced rather than remembered.
 *
 * Two things went wrong during the redesign that no other test could catch.
 * Components picked their own colours, so the same status came out blue in one
 * place and amber in another. And several tokens sat just under the contrast
 * floor, which is invisible until somebody cannot read the screen.
 *
 * Both are checked here, against the stylesheet itself, so a new theme or a
 * new status cannot quietly reintroduce either.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(here, '..');
const CSS = readFileSync(join(SRC, 'index.css'), 'utf8');

// ---------------------------------------------------------------------------
// No colour literals outside the files whose job is to define them
// ---------------------------------------------------------------------------

/** The only places a raw colour belongs. */
const COLOUR_FILES = [
  'index.css',
  // Label colours are chosen per label and stored in the database; the picker
  // needs literals to offer.
  join('features', 'tasks', 'labelsApi.ts'),
  join('__tests__', 'tokens.test.ts'),
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx|css)$/.test(entry) ? [full] : [];
  });
}

describe('colour literals', () => {
  it('appear only in the files that define the palette', () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      if (COLOUR_FILES.some((allowed) => rel === allowed)) continue;

      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          // Three, six or eight digit hex, as a CSS or JS value.
          const match = /#[0-9a-fA-F]{3,8}\b/.exec(line);
          if (!match) return;
          // A fragment identifier or an SVG reference is not a colour.
          if (/url\(#|href="#|id="/.test(line)) return;
          offenders.push(rel + ':' + (index + 1) + '  ' + line.trim().slice(0, 80));
        });
    }

    expect(
      offenders,
      'Use a token from packages/shared/colors.ts or a --color-* variable:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Contrast, including the tokens axe cannot see
// ---------------------------------------------------------------------------

const THEMES = ['midnight', 'dusk', 'light', 'violet'] as const;

function block(theme: string): string {
  const marker = theme === 'midnight' ? '@theme static {' : "[data-theme='" + theme + "'] {";
  const start = CSS.indexOf(marker);
  if (start === -1) throw new Error('No block for ' + theme);

  let depth = 1;
  let index = start + marker.length;
  while (index < CSS.length && depth > 0) {
    if (CSS[index] === '{') depth += 1;
    else if (CSS[index] === '}') depth -= 1;
    index += 1;
  }
  return CSS.slice(start + marker.length, index);
}

/** Composite a possibly translucent colour over an opaque one. */
function flatten(colour: string, behind: string): string {
  const rgba = /rgba?\(([^)]*)\)/.exec(colour);
  if (!rgba) return colour;

  const parts = (rgba[1] as string).split(',').map((part) => Number(part.trim()));
  const alpha = parts.length > 3 ? (parts[3] as number) : 1;
  const base = channels(behind).map((c) => c * 255) as [number, number, number];

  const mixed = [0, 1, 2].map((i) =>
    Math.round((parts[i] as number) * alpha + (base[i] as number) * (1 - alpha)),
  );

  return '#' + mixed.map((c) => c.toString(16).padStart(2, '0')).join('');
}

/**
 * The background a pill actually has: its own colour mixed into the card at
 * PILL_TINT. Checking the token against the bare card overstates the contrast,
 * because tinting with the same hue moves the background towards the text.
 */
function pillBackground(colour: string, surface: string): string {
  return flatten(
    'rgba(' +
      channels(colour)
        .map((c) => Math.round(c * 255))
        .join(',') +
      ',' +
      PILL_TINT / 100 +
      ')',
    surface,
  );
}

function tokens(theme: string): Record<string, string> {
  // midnight holds the defaults; the others only restate what they change.
  const base = theme === 'midnight' ? {} : tokens('midnight');
  const found: Record<string, string> = { ...base };
  // Hex and rgba alike: some tokens are deliberately translucent.
  for (const [, name, value] of block(theme).matchAll(
    /--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6}|rgba?\([^)]*\))/g,
  )) {
    found[name as string] = (value as string).trim();
  }
  return found;
}

/**
 * The tokens as they resolve inside .hero-surface.
 *
 * That block redefines a handful of variables so the card can stay dark in a
 * light theme. Several point at --color-hero-*, so they are followed here
 * the way the browser would.
 */
function heroTokens(palette: Record<string, string>): Record<string, string> {
  const start = CSS.indexOf('.hero-surface {');
  if (start === -1) throw new Error('No .hero-surface block');
  const body = CSS.slice(start, CSS.indexOf('\n  }', start));

  const resolved: Record<string, string> = { 'hero-to': palette['hero-to'] as string };

  for (const [, name, value] of body.matchAll(
    /--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6}|var\(--color-([a-z0-9-]+)\)|rgba?\([^)]*\))/g,
  )) {
    const key = name as string;
    const raw = (value as string).trim();
    const indirect = /^var\(--color-([a-z0-9-]+)\)$/.exec(raw);
    const literal = indirect ? palette[indirect[1] as string] : raw;
    if (literal && literal.startsWith('#')) resolved[key] = literal;
  }

  return resolved;
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

function lab(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map((c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  ) as [number, number, number];

  let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  let z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;

  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x);
  const fy = f(y);
  z = f(z);

  return [116 * fy - 16, 500 * (x - fy), 200 * (fy - z)];
}

function difference(a: string, b: string): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

/**
 * Anything a reader has to read: 4.5:1, the floor for text.
 *
 * Chart axis labels are text too, even though they live inside an SVG where
 * axe cannot see them. That is exactly why they are listed here.
 */
const TEXT = [
  'ink',
  'ink-muted',
  'ink-faint',
  'accent',
  'danger',
  'warning',
  'success',
  'info',
  'status-backlog',
  'status-assigned',
  'status-progress',
  'status-blocked',
  'status-review-ready',
  'status-review',
  'status-changes',
  'status-completed',
  'status-cancelled',
  'priority-low',
  'priority-medium',
  'priority-high',
  'priority-urgent',
  'chart-axis',
];

/**
 * Chart fills and strokes: 3:1, the floor for a graphical object under WCAG
 * 1.4.11. They are shapes, not words, and holding them to the text figure
 * would force every series into the same narrow band of darkness.
 */
const GRAPHIC = [
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'chart-6',
  'chart-7',
  'chart-8',
];

/**
 * The tokens that appear as text on a tint of themselves, via tintedPill.
 * These are the ones the plain-surface figure flatters.
 */
const PILLED = [
  'status-backlog',
  'status-assigned',
  'status-progress',
  'status-blocked',
  'status-review-ready',
  'status-review',
  'status-changes',
  'status-completed',
  'status-cancelled',
  'priority-low',
  'priority-medium',
  'priority-high',
  'priority-urgent',
];

/** Foregrounds paired with a matching `-soft` background, as bg-x-soft text-x. */
const SOFT_PAIRS = ['danger', 'warning', 'success', 'info', 'accent'];

/** The seven that share the status donut, and so must be told apart. */
const OPEN_STATUSES = [
  'status-backlog',
  'status-assigned',
  'status-progress',
  'status-blocked',
  'status-review-ready',
  'status-review',
  'status-changes',
];

describe.each(THEMES)('the %s theme', (theme) => {
  const palette = tokens(theme);

  it('clears 4.5:1 for every colour read as text', () => {
    const failures = TEXT.filter((name) => palette[name]).flatMap((name) => {
      const ratio = contrast(palette[name] as string, palette.surface as string);
      return ratio < 4.5 ? [name + ' ' + palette[name] + ' at ' + ratio.toFixed(2) + ':1'] : [];
    });

    expect(failures, 'against the card surface ' + palette.surface).toEqual([]);
  });

  it('clears 4.5:1 for every status and priority inside its pill', () => {
    const failures = PILLED.filter((name) => palette[name]).flatMap((name) => {
      const colour = palette[name] as string;
      const ratio = contrast(colour, pillBackground(colour, palette.surface as string));
      return ratio < 4.5 ? [name + ' ' + colour + ' at ' + ratio.toFixed(2) + ':1'] : [];
    });

    expect(failures, 'against its own ' + PILL_TINT + '% tint').toEqual([]);
  });

  it('keeps the heat-map ink readable at every step of the ramp', () => {
    // axe cannot follow a color-mix ramp, and the middle of one is exactly
    // where a two-colour scheme used to fail.
    const failures = [18, 40, 60, 80, 100].flatMap((percent) => {
      const behind = flatten(
        'rgba(' +
          channels(palette['heat-max'] as string)
            .map((c) => Math.round(c * 255))
            .join(',') +
          ',' +
          percent / 100 +
          ')',
        palette.surface as string,
      );
      const ratio = contrast(palette.ink as string, behind);
      return ratio < 4.5 ? [percent + '% at ' + ratio.toFixed(2) + ':1'] : [];
    });

    expect(failures, 'ink on the heat ramp').toEqual([]);
  });

  it('keeps the hero figures readable on the hero, not on the card', () => {
    /*
     * The hero is dark in every theme, and it redefines the tokens inside
     * itself so a number on it is not coloured for a white card. This checks
     * that every colour it redefines actually clears against the hero's own
     * background: in light, "Due today" was a dark brown-amber on navy
     * because --color-warning was not one of them.
     */
    const hero = heroTokens(palette);
    const behind = hero['hero-to'] as string;

    const failures = ['ink', 'ink-muted', 'accent', 'success', 'danger', 'warning', 'info'].flatMap(
      (name) => {
        const colour = hero[name];
        if (!colour) return [name + ' is not redefined inside the hero'];
        const ratio = contrast(colour, behind);
        return ratio < 4.5 ? [name + ' ' + colour + ' at ' + ratio.toFixed(2) + ':1'] : [];
      },
    );

    expect(failures, 'against the hero background ' + behind).toEqual([]);
  });

  it('clears 4.5:1 for the ink colours on a muted surface too', () => {
    /*
     * Checking the ink only against the card was not enough. Half the
     * controls sit on --color-surface-muted, which is a shade away, and
     * ink-faint was just under the floor on it in all four themes: the
     * "Nobody" in a person picker, every placeholder, every hint.
     */
    const behind = flatten(palette['surface-muted'] as string, palette.surface as string);

    const failures = ['ink', 'ink-muted', 'ink-faint'].flatMap((name) => {
      const ratio = contrast(palette[name] as string, behind);
      return ratio < 4.5 ? [name + ' ' + palette[name] + ' at ' + ratio.toFixed(2) + ':1'] : [];
    });

    expect(failures, 'against the muted surface ' + behind).toEqual([]);
  });

  it('pairs an ink with every filled background', () => {
    /*
     * Both ends of the brand gradient, not the text accent. A primary button
     * is painted with a background-image, which axe skips entirely, so this
     * is the only place the pairing is checked at all. It is how white ink
     * on a bright cyan gradient survived in two themes.
     */
    const pairs: Array<[string, string]> = [
      ['danger-ink', 'danger'],
      ['accent-ink', 'accent-from'],
      ['accent-ink', 'accent-to'],
    ];

    const failures = pairs.flatMap(([ink, fill]) => {
      if (!palette[ink] || !palette[fill]) return [];
      const ratio = contrast(palette[ink] as string, palette[fill] as string);
      return ratio < 4.5 ? [ink + ' on ' + fill + ' at ' + ratio.toFixed(2) + ':1'] : [];
    });

    expect(failures).toEqual([]);
  });

  it('clears 4.5:1 for every colour set on its soft background', () => {
    const failures = SOFT_PAIRS.filter((name) => palette[name + '-soft']).flatMap((name) => {
      const behind = flatten(palette[name + '-soft'] as string, palette.surface as string);
      const ratio = contrast(palette[name] as string, behind);
      return ratio < 4.5
        ? [name + ' on ' + name + '-soft (' + behind + ') at ' + ratio.toFixed(2) + ':1']
        : [];
    });

    expect(failures).toEqual([]);
  });

  it('clears 3:1 for every colour drawn as a chart mark', () => {
    const failures = GRAPHIC.filter((name) => palette[name]).flatMap((name) => {
      const ratio = contrast(palette[name] as string, palette.surface as string);
      return ratio < 3 ? [name + ' ' + palette[name] + ' at ' + ratio.toFixed(2) + ':1'] : [];
    });

    expect(failures, 'against the card surface ' + palette.surface).toEqual([]);
  });

  it('keeps the seven open statuses far enough apart to tell apart', () => {
    const tooClose: string[] = [];

    for (let i = 0; i < OPEN_STATUSES.length; i += 1) {
      for (let j = i + 1; j < OPEN_STATUSES.length; j += 1) {
        const a = OPEN_STATUSES[i] as string;
        const b = OPEN_STATUSES[j] as string;
        const delta = difference(palette[a] as string, palette[b] as string);
        if (delta < 22) tooClose.push(a + ' vs ' + b + ' at dE ' + delta.toFixed(1));
      }
    }

    expect(tooClose).toEqual([]);
  });

  it('defines every token the application reads', () => {
    const missing = [
      ...TEXT,
      ...GRAPHIC,
      'surface',
      'canvas',
      'chart-muted',
      'chart-grid',
      'heat-max',
      'danger-ink',
      'accent-ink',
      'accent-from',
      'accent-to',
      'surface-muted',
    ].filter((name) => !palette[name]);
    expect(missing).toEqual([]);
  });
});
