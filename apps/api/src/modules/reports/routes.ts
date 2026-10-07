import { Router } from 'express';
import { reportExportQuerySchema, reportQuerySchema } from '@tm/shared';
import type { ReportExportQuery, ReportQuery } from '@tm/shared';
import { authenticate, requireActor, requireRole } from '../../middleware/authenticate';
import { handler, validate } from '../../middleware/validate';
import * as service from './service';
import { reportToCsv, reportToXlsx } from './export';

/**
 * Reports: for whoever is accountable for a team's work.
 *
 * Leads and administrators only, enforced here as well as in the service.
 * A member's own numbers are on their member page; a page of everybody's is
 * a different thing, and the brief is explicit that the product shows facts
 * rather than anything a person could be ranked by.
 */
export const reportsRouter: Router = Router();

reportsRouter.use(authenticate);
reportsRouter.use(requireRole('TEAM_LEAD', 'SUPER_ADMIN'));

reportsRouter.get(
  '/',
  validate({ query: reportQuerySchema }),
  handler(async (req, res) => {
    const report = await service.buildReport(
      requireActor(req),
      req.query as unknown as ReportQuery,
    );
    res.json(report);
  }),
);

reportsRouter.get(
  '/export',
  validate({ query: reportExportQuerySchema }),
  handler(async (req, res) => {
    const query = req.query as unknown as ReportExportQuery;
    const report = await service.buildReport(requireActor(req), query);

    const stamp = report.range.from + '_to_' + report.range.to;

    if (query.format === 'xlsx') {
      const file = await reportToXlsx(query, report);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', 'attachment; filename="report_' + stamp + '.xlsx"');
      res.send(file);
      return;
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="report_' + stamp + '.csv"');
    res.send(reportToCsv(query, report));
  }),
);
