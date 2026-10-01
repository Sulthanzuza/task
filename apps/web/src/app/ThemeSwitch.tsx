import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { THEME_META, THEMES, useTheme, type Theme } from './theme';
import { cn } from '@/lib/utils';

/**
 * Three icons in a row, as in the reference: moon, cloud, sun.
 *
 * Violet is the fourth theme and does not belong in that row — it is a
 * different palette rather than a different brightness — so it sits in a small
 * menu beside them.
 */

const INLINE: Theme[] = ['midnight', 'dusk', 'light'];

export function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const current = THEME_META[theme];
  const CurrentIcon = current.icon;

  return (
    <div ref={ref} className="relative flex items-center">
      {/*
        On a phone this is one round button showing the theme you are in.
        Hiding the three icons and leaving the pill behind gave a tall empty
        capsule with a chevron in it, which said nothing about the theme and
        was the widest piece of nothing in the bar.
      */}
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={'Theme: ' + current.label + '. Choose another'}
        onClick={() => setOpen((shown) => !shown)}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border-subtle bg-surface text-ink transition-colors hover:border-border-strong sm:hidden"
      >
        <CurrentIcon size={17} aria-hidden />
      </button>

      <div
        role="radiogroup"
        aria-label="Theme"
        className="hidden items-center gap-0.5 rounded-full border border-border-subtle bg-surface/70 p-0.5 sm:flex"
      >
        {INLINE.map((name) => {
          const meta = THEME_META[name];
          const Icon = meta.icon;
          const active = theme === name;
          return (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={meta.label + ' theme'}
              title={meta.label + ' — ' + meta.hint}
              onClick={() => setTheme(name)}
              className={cn(
                'inline-flex rounded-full p-1.5 transition-all',
                active
                  ? 'accent-gradient text-[var(--color-accent-ink)]'
                  : 'text-ink-faint hover:text-ink',
              )}
            >
              <Icon size={15} />
            </button>
          );
        })}

        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="More themes"
          onClick={() => setOpen((shown) => !shown)}
          className={cn(
            'rounded-full p-1.5 transition-all',
            theme === 'violet'
              ? 'accent-gradient text-[var(--color-accent-ink)]'
              : 'text-ink-faint hover:text-ink',
          )}
        >
          <ChevronDown size={14} />
        </button>
      </div>

      {open ? (
        <div
          role="menu"
          aria-label="Themes"
          className="absolute top-full right-0 z-50 mt-2 w-48 rounded-2xl border border-border-subtle bg-surface p-1.5 shadow-[var(--shadow-lift)]"
        >
          {THEMES.map((name) => {
            const meta = THEME_META[name];
            const Icon = meta.icon;
            return (
              <button
                key={name}
                type="button"
                role="menuitemradio"
                aria-checked={theme === name}
                onClick={() => {
                  setTheme(name);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition-colors',
                  theme === name
                    ? 'bg-accent-soft text-accent'
                    : 'text-ink-muted hover:bg-surface-muted',
                )}
              >
                <Icon size={15} aria-hidden />
                <span className="flex-1">
                  <span className="block">{meta.label}</span>
                  <span className="block text-[11px] text-ink-faint">{meta.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
