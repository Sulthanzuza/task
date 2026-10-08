/**
 * The colours the markup editor draws with.
 *
 * Literals, deliberately, and the only file in the feature allowed them.
 * Everything else in the app takes its colour from a theme token, because the
 * same pixel should look right in all four themes. These are the opposite
 * case: they are pigment, flattened into a PNG and uploaded. An arrow drawn
 * in `--color-accent` would be cyan for one reader and violet for the next,
 * and whichever one the author saw is the one that mattered.
 *
 * Chosen to stay visible on a screenshot of this app and of anything else:
 * a warm red and orange for pointing at things, a green for ticking them, a
 * blue that is not the app's blue, and near-black for writing on pale
 * screenshots.
 */

export const MARKUP_COLORS = [
  '#ef4444', // red
  '#f59e0b', // amber
  '#22c55e', // green
  '#3b82f6', // blue
  '#0f172a', // near-black
] as const;

export type MarkupColor = (typeof MARKUP_COLORS)[number];

/** Thin, medium, thick, in image pixels. */
export const MARKUP_SIZES = [3, 6, 12] as const;

/**
 * The editor's own furniture, which is drawn on the canvas and so cannot come
 * from CSS either. The blur block is a flat slate so it reads as "covered"
 * rather than as part of the picture; the crop outline is a bright cyan that
 * no screenshot is likely to hide.
 */
export const MARKUP_CHROME = {
  blurFill: '#64748b',
  blurEdge: '#0f172a',
  cropOutline: '#38bdf8',
  /** PDF pages are transparent where nothing is drawn, which reads as black. */
  pageBackground: '#ffffff',
} as const;
