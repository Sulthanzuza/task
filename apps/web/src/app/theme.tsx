import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Cloud, Moon, Sparkles, Sun } from 'lucide-react';

/**
 * Four themes, remembered per person.
 *
 * The attribute is already on <html> before React runs — index.html sets it, so
 * nobody sees the default flash past their choice. This provider keeps it in
 * step afterwards and writes the choice down.
 */

export const THEMES = ['midnight', 'dusk', 'light', 'violet'] as const;
export type Theme = (typeof THEMES)[number];

const STORAGE_KEY = 'tm-theme';

export const THEME_META: Record<Theme, { label: string; icon: typeof Moon; hint: string }> = {
  midnight: { label: 'Midnight', icon: Moon, hint: 'Dark navy' },
  dusk: { label: 'Dusk', icon: Cloud, hint: 'Slate blue' },
  light: { label: 'Light', icon: Sun, hint: 'Pale lavender' },
  violet: { label: 'Violet', icon: Sparkles, hint: 'Near black and magenta' },
};

function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/** What index.html decided, so the provider starts from the same answer. */
function currentTheme(): Theme {
  if (typeof document !== 'undefined') {
    const attribute = document.documentElement.getAttribute('data-theme');
    if (isTheme(attribute)) return attribute;
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    // Private browsing can block storage; fall through to the system preference.
  }

  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'midnight';
}

interface ThemeValue {
  theme: Theme;
  setTheme(next: Theme): void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(currentTheme);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not being able to remember the choice is not worth breaking the page over.
    }
  }, []);

  /*
   * Follow the system only while nothing has been chosen. Once somebody picks a
   * theme it is theirs, and the operating system switching at sunset must not
   * take it away from them.
   */
  useEffect(() => {
    let chosen = false;
    try {
      chosen = localStorage.getItem(STORAGE_KEY) !== null;
    } catch {
      chosen = false;
    }
    if (chosen) return;

    const query = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (event: MediaQueryListEvent) => {
      const next: Theme = event.matches ? 'light' : 'midnight';
      setThemeState(next);
      document.documentElement.setAttribute('data-theme', next);
    };

    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}

/** True while the page is in one of the dark themes, for charts that need to know. */
export function useIsDark(): boolean {
  const { theme } = useTheme();
  return theme === 'midnight' || theme === 'violet';
}
