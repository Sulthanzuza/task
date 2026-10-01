import { useQuery } from '@tanstack/react-query';
import type { WorkCalendarView } from '@tm/shared';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

/**
 * Which days the organisation does not work.
 *
 * Held for an hour: it changes a few times a year, every screen that draws a
 * week wants it, and refetching it on every navigation would be a request
 * per page for an answer that has not moved.
 */
export function useWorkCalendar() {
  return useQuery({
    queryKey: queryKeys.org.calendar(),
    queryFn: ({ signal }) => api.get<WorkCalendarView>('/org/calendar', signal),
    staleTime: 60 * 60 * 1000,
  });
}

/** Weekend or holiday, by the organisation's own rules rather than the browser's. */
export function nonWorkingDay(
  date: string,
  calendar: WorkCalendarView | undefined,
): { weekend: boolean; holiday: string | null } {
  if (!calendar) return { weekend: false, holiday: null };

  const [y, m, d] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(y as number, (m as number) - 1, d as number)).getUTCDay();

  return {
    weekend: calendar.weekendDays.includes(weekday),
    holiday: calendar.holidays.find((holiday) => holiday.date === date)?.name ?? null,
  };
}
