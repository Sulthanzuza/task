import ExcelJS from 'exceljs';
import type { Report, ReportQuery } from '@tm/shared';
import { BLOCKER_TYPE_LABELS } from '@tm/shared';

/**
 * The report, as a file.
 *
 * Both formats carry the filters. A spreadsheet of numbers with no record of
 * which range and which team produced them is a spreadsheet nobody can
 * check a week later, and that is the state most exported reports end up in.
 *
 * Dates are written in the organisation's time zone, the same as the screen,
 * because a reader comparing the file against the page must not find them a
 * day apart.
 */

interface Section {
  name: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
}

function filterRows(query: ReportQuery, report: Report): Section {
  return {
    name: 'Filters',
    columns: ['Filter', 'Value'],
    rows: [
      ['Range', report.range.label],
      ['From', report.range.from],
      ['To', report.range.to],
      ['Compared with', report.range.previousFrom + ' to ' + report.range.previousTo],
      ['Time zone', report.range.timezone],
      ['Team', query.teamId ?? 'All teams the reader can see'],
      ['Project', query.projectId ?? 'All'],
      ['Member', query.assigneeId ?? 'All'],
      ['Label', query.labelId ?? 'All'],
      ['Generated', new Date().toISOString()],
      [
        'Note',
        'Group containers and internal teams are excluded. Cycle and blocked time are working hours.',
      ],
    ],
  };
}

function sections(query: ReportQuery, report: Report): Section[] {
  const s = report.summary;

  return [
    filterRows(query, report),
    {
      name: 'Summary',
      columns: ['Metric', 'Value', 'Previous period'],
      rows: [
        ['Created', s.created.value, s.created.previous],
        ['Completed', s.completed.value, s.completed.previous],
        ['On-time rate (%)', s.onTimeRate?.value ?? null, s.onTimeRate?.previous ?? null],
        [
          'Median cycle time (working hours)',
          s.medianCycleHours?.value ?? null,
          s.medianCycleHours?.previous ?? null,
        ],
        ['Overdue now', s.overdueNow.value, null],
        ['Blocked now', s.blockedNow.value, null],
      ],
    },
    {
      name: 'Throughput',
      columns: ['Week beginning', 'Created', 'Completed'],
      rows: report.throughput.map((week) => [week.weekStart, week.created, week.completed]),
    },
    {
      name: 'Overdue trend',
      columns: ['Date', 'Open overdue', 'Rebuilt from history'],
      rows: report.overdueTrend.map((day) => [day.date, day.overdue, day.estimated ? 'yes' : 'no']),
    },
    {
      name: 'Cycle time',
      columns: ['Grouping', 'Key', 'Median hours', '75th percentile hours', 'Completed'],
      rows: [
        ...report.cycleByWeek.map((row) => [
          'Week',
          row.label,
          row.medianHours,
          row.p75Hours,
          row.completed,
        ]),
        ...report.cycleByLabel.map((row) => [
          'Label',
          row.label,
          row.medianHours,
          row.p75Hours,
          row.completed,
        ]),
        ...report.cycleByPriority.map((row) => [
          'Priority',
          row.label,
          row.medianHours,
          row.p75Hours,
          row.completed,
        ]),
      ],
    },
    {
      name: 'Blocked time',
      columns: ['Blocker type', 'Working hours', 'Spells', 'Task', 'Title', 'Still blocked'],
      rows: [
        ...report.blockedByType.map((row) => [row.label, row.hours, row.spells, null, null, null]),
        ...report.longestBlocked.map((task) => [
          task.blockerType ? BLOCKER_TYPE_LABELS[task.blockerType] : 'Unknown',
          task.hours,
          null,
          task.key,
          task.title,
          task.current ? 'yes' : 'no',
        ]),
      ],
    },
    {
      name: 'People',
      columns: [
        'Name',
        'Completed',
        'On-time rate (%)',
        'Median cycle hours',
        'Open now',
        'Overdue now',
      ],
      rows: report.people.map((person) => [
        person.user.name,
        person.completed,
        person.onTimeRate,
        person.medianCycleHours,
        person.openNow,
        person.overdueNow,
      ]),
    },
    {
      name: 'Projects',
      columns: [
        'Key',
        'Name',
        'Open now',
        'Completed',
        'Overdue now',
        'On-time rate (%)',
        'Done (%)',
      ],
      rows: report.projects.map((project) => [
        project.key,
        project.name,
        project.openNow,
        project.completed,
        project.overdueNow,
        project.onTimeRate,
        project.percentDone,
      ]),
    },
  ];
}

/** One field, escaped the way a spreadsheet expects to read it back. */
function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/**
 * CSV cannot hold several sheets, so the sections are stacked with their
 * names as headings. One file, readable top to bottom, rather than seven
 * files or a flattened join nobody asked for.
 */
export function reportToCsv(query: ReportQuery, report: Report): string {
  const lines: string[] = [];

  for (const section of sections(query, report)) {
    lines.push('# ' + section.name);
    lines.push(section.columns.map(csvCell).join(','));
    for (const row of section.rows) lines.push(row.map(csvCell).join(','));
    lines.push('');
  }

  return lines.join('\n');
}

export async function reportToXlsx(query: ReportQuery, report: Report): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  book.creator = 'Team Task Manager';
  book.created = new Date();

  for (const section of sections(query, report)) {
    // 31 characters is Excel's sheet-name limit, and it fails rather than truncating.
    const sheet = book.addWorksheet(section.name.slice(0, 31));
    sheet.addRow(section.columns);
    sheet.getRow(1).font = { bold: true };

    for (const row of section.rows) sheet.addRow(row);

    sheet.columns.forEach((column) => {
      let widest = 10;
      column.eachCell?.({ includeEmpty: false }, (cell) => {
        widest = Math.max(widest, String(cell.value ?? '').length + 2);
      });
      column.width = Math.min(widest, 60);
    });

    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  const buffer = await book.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export { sections as reportSections };
