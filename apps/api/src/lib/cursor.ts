import { ValidationError } from './errors';

/**
 * Keyset pagination. The cursor carries the sort value and the id of the last row,
 * so a page boundary stays correct even when rows are inserted while someone pages.
 */
export interface Cursor {
  /** The sort column's value on the last row of the previous page, as a string. */
  value: string | null;
  /** Tie-breaker, so rows with equal sort values are never skipped or repeated. */
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'id' in parsed &&
      typeof (parsed as Cursor).id === 'string'
    ) {
      const cursor = parsed as Cursor;
      return { id: cursor.id, value: cursor.value ?? null };
    }
  } catch {
    // Fall through to the error below.
  }
  throw new ValidationError('That page cursor is not valid.', { cursor: raw });
}

/**
 * Trim an over-fetched result down to a page and work out the next cursor.
 * Query one more row than the limit so "is there a next page" needs no count.
 */
export function buildPage<T>(
  rows: T[],
  limit: number,
  toCursor: (row: T) => Cursor,
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1] as T;
  return { items, nextCursor: encodeCursor(toCursor(last)) };
}
