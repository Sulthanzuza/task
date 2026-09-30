import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { UserSummary } from '@tm/shared';
import { MENTION_PATTERN } from '@tm/shared';
import { useMentionableUsers } from './attachmentsApi';
import { Textarea } from '@/components/ui/primitives';
import { UserAvatar } from '@/components/common/badges';
import { cn } from '@/lib/utils';

/**
 * A comment box that knows who is on the task.
 *
 * Typing @ opens the list, the arrow keys move through it and Enter or Tab
 * inserts the person. What is stored is @[Name](userId), which survives a
 * rename and cannot be spoofed by typing somebody's name; what is shown, once
 * posted, is a chip.
 *
 * The candidates come from the server, so nobody who cannot read the task is
 * ever offered.
 */

export interface MentionBoxProps {
  taskIdOrKey: string;
  value: string;
  onChange(value: string): void;
  onSubmit?: () => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
}

/** The @word immediately before the caret, if the caret is still inside one. */
function activeMention(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;

  // Only at a word boundary, so an email address does not open the list.
  const preceding = at === 0 ? '' : before[at - 1];
  if (preceding && !/\s|\(/.test(preceding)) return null;

  const query = before.slice(at + 1);
  // A space ends it, and so does the closing bracket of a finished mention.
  if (/[\s\]()]/.test(query)) return null;

  return { query, start: at };
}

export function MentionBox({
  taskIdOrKey,
  value,
  onChange,
  onSubmit,
  placeholder,
  rows = 3,
  disabled,
  id,
  'aria-label': ariaLabel,
}: MentionBoxProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  /*
   * The highlight remembers which query it belongs to, so a narrowing list
   * starts from the top again without an effect syncing two pieces of state.
   */
  const [highlight, setHighlight] = useState({ query: '', index: 0 });

  const mention = open ? activeMention(value, caret) : null;

  // Fetched once the box is in use, rather than on every task page load.
  const people = useMentionableUsers(taskIdOrKey, open);

  const matches = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.toLowerCase();
    const all = people.data?.items ?? [];
    if (query === '') return all.slice(0, 8);
    return all
      .filter(
        (person) =>
          person.name.toLowerCase().includes(query) || person.email.toLowerCase().includes(query),
      )
      .slice(0, 8);
  }, [mention, people.data]);

  const query = mention?.query ?? '';
  const highlighted =
    highlight.query === query ? Math.min(highlight.index, Math.max(matches.length - 1, 0)) : 0;

  const moveHighlight = (next: number) => setHighlight({ query, index: next });

  const showing = mention !== null && matches.length > 0;

  function insert(person: UserSummary) {
    if (!mention) return;

    const chip = '@[' + person.name + '](' + person.id + ')';
    const next = value.slice(0, mention.start) + chip + ' ' + value.slice(caret);

    onChange(next);
    setOpen(false);

    // Put the caret after what was just inserted, not at the end of the box.
    const position = mention.start + chip.length + 1;
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(position, position);
      setCaret(position);
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (showing) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveHighlight((highlighted + 1) % matches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveHighlight((highlighted - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const chosen = matches[highlighted];
        if (chosen) insert(chosen);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        return;
      }
    }

    // Ctrl+Enter posts, the way every other comment box does.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && onSubmit) {
      event.preventDefault();
      onSubmit();
    }
  }

  return (
    <div className="relative">
      <Textarea
        ref={textareaRef}
        id={id}
        aria-label={ariaLabel}
        rows={rows}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        /*
          aria-autocomplete and aria-controls belong on a textbox;
          aria-expanded does not, it is part of the combobox pattern, and a
          textarea may not take the combobox role. The open state is announced
          through the live region below instead.
        */
        aria-autocomplete="list"
        aria-controls={showing ? 'mention-list' : undefined}
        onChange={(event) => {
          onChange(event.target.value);
          setCaret(event.target.selectionStart);
          setOpen(true);
        }}
        onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
        onClick={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // After the click on a row has had its chance to land.
          window.setTimeout(() => setOpen(false), 150);
        }}
      />

      <p aria-live="polite" className="sr-only">
        {showing ? matches.length + ' people. Use the arrow keys to choose one.' : ''}
      </p>

      {showing ? (
        <ul
          id="mention-list"
          role="listbox"
          aria-label="People you can mention"
          className="absolute z-20 mt-1 max-h-56 w-64 overflow-y-auto rounded-lg border border-border-subtle bg-surface shadow-lg"
        >
          {matches.map((person, index) => (
            <li key={person.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlighted}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                  index === highlighted ? 'bg-accent-soft text-accent' : 'hover:bg-surface-muted',
                )}
                // The textarea's blur would otherwise fire before the click.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => moveHighlight(index)}
                onClick={() => insert(person)}
              >
                <UserAvatar user={person} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{person.name}</span>
                  <span className="block truncate text-xs text-ink-faint">{person.email}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * A posted comment, with its mentions drawn as chips.
 *
 * The stored form carries the id, so a chip can be highlighted when it is the
 * reader who was mentioned: the one thing they most want to spot in a long
 * thread.
 */
export function CommentBody({ body, meId }: { body: string; meId?: string | null }) {
  const parts: Array<string | { name: string; userId: string }> = [];
  let lastIndex = 0;

  for (const match of body.matchAll(MENTION_PATTERN)) {
    const at = match.index ?? 0;
    if (at > lastIndex) parts.push(body.slice(lastIndex, at));
    parts.push({ name: match[1] as string, userId: match[2] as string });
    lastIndex = at + match[0].length;
  }
  if (lastIndex < body.length) parts.push(body.slice(lastIndex));

  return (
    <p className="text-sm whitespace-pre-wrap">
      {parts.map((part, index) =>
        typeof part === 'string' ? (
          <span key={index}>{part}</span>
        ) : (
          <span
            key={index}
            data-testid="mention-chip"
            className={cn(
              'rounded px-1 py-0.5 text-[13px] font-medium',
              part.userId === meId ? 'bg-warning-soft text-warning' : 'bg-accent-soft text-accent',
            )}
          >
            @{part.name}
          </span>
        ),
      )}
    </p>
  );
}
