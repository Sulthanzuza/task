import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * One table treatment for every list of records.
 *
 * The point of it is the colgroup. Left to itself a table gives each column
 * whatever its widest cell asks for, so the same list looks different on two
 * screens and the columns shift under you as you page through it. Declaring
 * the widths up front makes a key column a key column everywhere, and lets a
 * long title truncate instead of shoving the dates off the edge.
 *
 * It stays a real table. Rebuilding it out of divs and a CSS grid would line
 * the columns up just as well and take the row and column semantics away
 * from anyone reading it with a screen reader.
 */

export interface Column {
  label: ReactNode;
  /** Any CSS width. 'auto' lets one column soak up the remaining space. */
  width: string;
  align?: 'left' | 'right';
  /** Dropped below this breakpoint, for columns that are nice to have. */
  hideBelow?: 'sm' | 'md' | 'lg';
}

const HIDDEN: Record<string, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
};

export function hiddenAt(breakpoint: Column['hideBelow']): string {
  return breakpoint ? (HIDDEN[breakpoint] as string) : '';
}

export function DataTable({
  columns,
  minWidth = '56rem',
  sticky = false,
  children,
  className,
}: {
  columns: Column[];
  /** Below this the table scrolls sideways inside its own box, not the page. */
  minWidth?: string;
  /** Under the 64px top bar, for the long lists you scroll through. */
  sticky?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    // relative, because a sr-only child of a static scroller is positioned
    // against the viewport and drags the whole document sideways.
    <div className={cn('relative overflow-x-auto', className)}>
      <table className="w-full table-fixed border-collapse text-sm" style={{ minWidth }}>
        <colgroup>
          {columns.map((column, index) => (
            <col
              key={index}
              style={column.width === 'auto' ? undefined : { width: column.width }}
            />
          ))}
        </colgroup>
        <thead>
          <tr
            className={cn(
              'border-b border-border-subtle text-left text-xs text-ink-muted',
              sticky && 'sticky top-16 z-10 bg-surface',
            )}
          >
            {columns.map((column, index) => (
              <th
                key={index}
                scope="col"
                className={cn(
                  'px-3 py-2 font-medium',
                  column.align === 'right' && 'text-right',
                  hiddenAt(column.hideBelow),
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        {children}
      </table>
    </div>
  );
}

/** A row's cell. Defaults match the header's padding so the columns align. */
export function Td({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td className={cn('px-3 py-2.5', className)} title={title}>
      {children}
    </td>
  );
}

/**
 * Text that must not widen its column.
 *
 * Every truncated string carries the whole of itself in a title, because a
 * name cut off mid-word with no way to see the rest is worse than a wrapped
 * one.
 */
export function Truncated({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn('block truncate', className)} title={text}>
      {text}
    </span>
  );
}
