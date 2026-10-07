import { useQuery } from '@tanstack/react-query';
import type { Report, ReportQuery } from '@tm/shared';
import { api, toQuery } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

/**
 * The whole report in one request.
 *
 * Seven sections that all share the same filters and the same range, so
 * fetching them separately would mean seven chances for one of them to
 * disagree with the others about what "this month" meant.
 */
export function useReport(query: ReportQuery, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.reports.detail(query),
    queryFn: ({ signal }) => api.get<Report>('/reports' + toQuery(query), signal),
    // The numbers move when work moves, not second to second.
    staleTime: 60_000,
    // A half-finished custom range is not worth a request the API will refuse.
    enabled: options.enabled ?? true,
  });
}

/** Where the export lives, for a plain link rather than a fetch and a blob. */
export function reportExportHref(query: ReportQuery, format: 'csv' | 'xlsx'): string {
  return '/api/v1/reports/export' + toQuery({ ...query, format });
}
