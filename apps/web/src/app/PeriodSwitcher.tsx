import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { SegmentedTabs } from '@/components/ui/primitives';

/**
 * This week / This month / Quarter.
 *
 * Only shown where a page actually reads it. A control that changes nothing is
 * worse than no control, so the list of pages that use it lives here rather
 * than being implied.
 */

export const PERIODS = ['week', 'month', 'quarter'] as const;
export type Period = (typeof PERIODS)[number];

export const PERIOD_OPTIONS: ReadonlyArray<{ value: Period; label: string }> = [
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'quarter', label: 'Quarter' },
];

/** The paths whose figures move with the period. */
const USES_PERIOD = ['/dashboard', '/reports'];

interface PeriodValue {
  period: Period;
  setPeriod(next: Period): void;
}

const PeriodContext = createContext<PeriodValue | null>(null);

export function PeriodProvider({ children }: { children: ReactNode }) {
  const [period, setPeriod] = useState<Period>('week');
  const value = useMemo(() => ({ period, setPeriod }), [period]);
  return <PeriodContext.Provider value={value}>{children}</PeriodContext.Provider>;
}

export function usePeriod(): PeriodValue {
  const value = useContext(PeriodContext);
  if (!value) throw new Error('usePeriod must be used inside PeriodProvider');
  return value;
}

export function PeriodSwitcher() {
  const { period, setPeriod } = usePeriod();
  const { pathname } = useLocation();

  if (!USES_PERIOD.some((path) => pathname.startsWith(path))) return null;

  return (
    <SegmentedTabs
      label="Period"
      options={PERIOD_OPTIONS}
      value={period}
      onChange={setPeriod}
      className="mr-1 hidden min-[1400px]:inline-flex"
    />
  );
}
