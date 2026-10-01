import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A list of choices in the application's own clothes.
 *
 * A native select is the one control on a form that the operating system
 * draws, so it ignores the theme entirely: a white Windows dropdown in the
 * middle of a dark drawer. This keeps the keyboard behaviour that matters
 * (Radix handles focus, Escape and outside clicks) and lets the rest look
 * like the page it is on.
 *
 * For a handful of short choices use a segmented control instead; this is
 * for lists long enough to need a menu.
 */

export interface PickerOption {
  value: string;
  label: string;
}

export function OptionPicker({
  value,
  onChange,
  options,
  label,
  placeholder = 'Choose…',
  disabled = false,
  className,
}: {
  value: string;
  onChange(next: string): void;
  options: PickerOption[];
  /** Names the trigger, which shows the choice rather than the field. */
  label: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const chosen = options.find((option) => option.value === value);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        disabled={disabled || options.length === 0}
        aria-label={label + (chosen ? ': ' + chosen.label : '')}
        className={cn(
          'flex h-9 w-full items-center gap-2 rounded-[var(--radius-input)] border',
          'border-border-subtle bg-surface-muted px-2.5 text-sm text-ink transition-colors',
          'hover:border-border-strong focus-visible:border-accent focus-visible:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-70',
          className,
        )}
      >
        <span className={cn('min-w-0 flex-1 truncate text-left', !chosen && 'text-ink-faint')}>
          {chosen?.label ?? placeholder}
        </span>
        <ChevronDown size={14} aria-hidden className="shrink-0 text-ink-faint" />
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 max-h-64 w-[var(--radix-popover-trigger-width)] overflow-y-auto rounded-[var(--radius-card)] border border-border-subtle bg-surface p-1.5 shadow-xl"
        >
          <ul role="listbox" aria-label={label}>
            {options.map((option) => {
              const selected = option.value === value;
              return (
                <li key={option.value} role="option" aria-selected={selected}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors',
                      'hover:bg-surface-muted',
                      selected && 'bg-accent-soft',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    <Check
                      size={13}
                      aria-hidden
                      className={cn('shrink-0 text-accent', selected ? 'opacity-100' : 'opacity-0')}
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
