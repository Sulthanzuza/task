import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/utils';

/** The small set of building blocks the whole app is made of. */

const buttonStyles = cva(
  // Pills throughout, as in both references.
  'inline-flex items-center justify-center gap-2 rounded-full text-sm font-medium transition-all ' +
    'disabled:pointer-events-none disabled:opacity-50 whitespace-nowrap',
  {
    variants: {
      variant: {
        primary:
          'accent-gradient text-[var(--color-accent-ink)] shadow-[0_6px_18px_-8px_var(--color-accent)] hover:brightness-110',
        secondary: 'bg-surface-muted text-ink hover:bg-border-subtle',
        outline: 'border border-border-subtle bg-surface text-ink hover:border-border-strong',
        ghost: 'text-ink-muted hover:bg-surface-muted hover:text-ink',
        danger: 'bg-danger text-white hover:brightness-110',
      },
      size: {
        sm: 'h-8 px-3.5 text-xs',
        md: 'h-9 px-4',
        lg: 'h-11 px-6',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonStyles> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild, ...props },
  ref,
) {
  const Component = asChild ? Slot : 'button';
  return (
    <Component ref={ref} className={cn(buttonStyles({ variant, size }), className)} {...props} />
  );
});

const fieldStyles =
  'w-full rounded-[var(--radius-input)] border border-border-subtle bg-surface-muted text-sm text-ink ' +
  'placeholder:text-ink-faint focus:border-accent focus:bg-surface transition-colors';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(fieldStyles, 'h-10 px-3.5', className)} {...props} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(fieldStyles, 'min-h-20 resize-y px-3.5 py-2.5', className)}
      {...props}
    />
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select ref={ref} className={cn(fieldStyles, 'h-10 px-3', className)} {...props}>
        {children}
      </select>
    );
  },
);

export function Label({
  children,
  htmlFor,
  hint,
}: {
  children: ReactNode;
  htmlFor?: string;
  hint?: string;
}) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-medium text-ink-muted">
      {children}
      {hint ? <span className="ml-1 font-normal text-ink-faint">{hint}</span> : null}
    </label>
  );
}

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-1 text-xs text-danger">
      {message}
    </p>
  );
}

/**
 * The card.
 *
 * Generously rounded with 20px of padding by default, as in the references.
 * `interactive` adds the hover lift, and is only for cards that actually go
 * somewhere: a card that rises under the cursor and then does nothing is a lie.
 */
export function Card({
  className,
  children,
  interactive,
  padded = true,
  ...rest
}: {
  className?: string;
  children: ReactNode;
  interactive?: boolean;
  padded?: boolean;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'className' | 'children'>) {
  return (
    <div
      className={cn(
        // min-w-0 so a card in a grid is never forced wider than its track by
        // its own contents; a chart will happily do that given the chance.
        'min-w-0 rounded-[var(--radius-card)] border border-border-subtle bg-surface shadow-[var(--shadow-card)]',
        padded && 'p-5',
        interactive &&
          'cursor-pointer transition-all hover:-translate-y-0.5 hover:border-border-strong hover:shadow-[var(--shadow-lift)]',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/** The dark gradient card from the reference. Dark in every theme, on purpose. */
export function HeroCard({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'hero-surface rounded-[var(--radius-card)] p-5 shadow-[var(--shadow-card)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-4 flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-ink-faint">{subtitle}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * The segmented control from the reference's "Costs / Goals / Inflow".
 *
 * Radio semantics rather than buttons, because exactly one is always chosen.
 */
export function SegmentedTabs<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange(next: T): void;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full border border-border-subtle bg-surface-muted p-0.5',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition-all',
              active
                ? 'accent-gradient text-[var(--color-accent-ink)]'
                : 'text-ink-muted hover:text-ink',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A small rounded chip. Always carries text, never colour alone. */
export function Pill({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'danger' | 'warning' | 'success' | 'info';
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-neutral-soft text-ink-muted',
    accent: 'bg-accent-soft text-accent',
    danger: 'bg-danger-soft text-danger',
    warning: 'bg-warning-soft text-warning',
    success: 'bg-success-soft text-success',
    info: 'bg-info-soft text-info',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-[var(--radius-input)]', className)} />;
}

export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('px-6 py-10 text-center', className)}>
      <p className="text-sm font-medium">{title}</p>
      {description ? (
        <p className="mx-auto mt-1 max-w-sm text-sm text-ink-faint">{description}</p>
      ) : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent',
        className,
      )}
    />
  );
}

/** A big figure, set the way every number in the app is set. */
export function Figure({
  value,
  className,
  size = 'lg',
}: {
  value: ReactNode;
  className?: string;
  size?: 'lg' | 'md';
}) {
  return (
    <span
      className={cn(
        'tabular font-bold tracking-tight',
        size === 'lg' ? 'text-[32px] leading-none' : 'text-[28px] leading-none',
        className,
      )}
    >
      {value}
    </span>
  );
}

/** The 12px muted label that sits under or beside a figure. */
export function FigureLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('text-xs text-ink-muted', className)}>{children}</span>;
}
