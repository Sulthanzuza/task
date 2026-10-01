import { z } from 'zod';
import { dateOnlySchema, uuidSchema } from './common';

/** Organisation settings, holidays and the audit log: the admin area's data. */

export const holidaySchema = z.object({
  date: dateOnlySchema,
  name: z.string(),
});
export type Holiday = z.infer<typeof holidaySchema>;

export const createHolidaySchema = z.object({
  date: dateOnlySchema,
  name: z.string().trim().min(1, 'Give the day a name').max(120),
});
export type CreateHolidayInput = z.infer<typeof createHolidaySchema>;

/**
 * Adding a year at a time.
 *
 * A calendar is pasted in, not typed one row at a time, so the API takes the
 * whole list. Duplicates are the normal case when last year's list is pasted
 * over this one, so they are not an error.
 */
export const bulkHolidaysSchema = z.object({
  items: z.array(createHolidaySchema).min(1, 'Nothing to add').max(400),
});
export type BulkHolidaysInput = z.infer<typeof bulkHolidaysSchema>;

/**
 * Parses pasted holiday lines.
 *
 * Accepts "2026-01-26, Republic Day", tab separated, or a CSV export with a
 * header. Shared so the paste box previews exactly what the API will accept.
 */
export function parseHolidayLines(text: string): {
  items: CreateHolidayInput[];
  problems: Array<{ line: number; text: string; message: string }>;
} {
  const items: CreateHolidayInput[] = [];
  const problems: Array<{ line: number; text: string; message: string }> = [];

  const lines = text.split(/\r?\n/);

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === '') return;

    // A header row from a spreadsheet export, which is not a holiday.
    if (/^["']?date["']?\s*[,;\t]/i.test(line)) return;

    const parts = line
      .split(/[,;\t]/)
      .map((part) => part.trim().replace(/^["']|["']$/g, ''))
      .filter((part) => part !== '');

    const [date, ...rest] = parts;
    const name = rest.join(', ');

    if (!date || !name) {
      problems.push({
        line: index + 1,
        text: line,
        message: 'Write a date and a name, like 2026-01-26, Republic Day',
      });
      return;
    }

    const parsed = createHolidaySchema.safeParse({ date, name });
    if (!parsed.success) {
      problems.push({
        line: index + 1,
        text: line,
        message: parsed.error.issues[0]?.message ?? 'That line could not be read',
      });
      return;
    }

    items.push(parsed.data);
  });

  return { items, problems };
}

export const orgSettingsSchema = z.object({
  timezone: z.string(),
  weekendDays: z.array(z.number().int().min(0).max(6)),
  weekStartsOn: z.number().int().min(0).max(6),
  workHoursPerDay: z.number(),
  noUpdateThresholdHours: z.number().int(),
  blockedEscalationHours: z.number().int(),
  reviewWaitingThresholdHours: z.number().int(),
  overdueEscalationWorkingDays: z.number().int(),
  digestTime: z.string(),
  checkinReminderTime: z.string(),
  quietHoursStart: z.number().int(),
  quietHoursEnd: z.number().int(),
});
export type OrgSettingsView = z.infer<typeof orgSettingsSchema>;

/** Every field optional: the form sends only what changed. */
export const updateOrgSettingsSchema = z
  .object({
    timezone: z.string().min(1).max(64).optional(),
    weekendDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    weekStartsOn: z.number().int().min(0).max(6).optional(),
    workHoursPerDay: z.number().min(1).max(24).optional(),
    noUpdateThresholdHours: z.number().int().min(1).max(336).optional(),
    blockedEscalationHours: z.number().int().min(1).max(336).optional(),
    reviewWaitingThresholdHours: z.number().int().min(1).max(336).optional(),
    overdueEscalationWorkingDays: z.number().int().min(1).max(30).optional(),
    digestTime: z
      .string()
      .regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use a time like 09:00')
      .optional(),
    quietHoursStart: z.number().int().min(0).max(23).optional(),
    quietHoursEnd: z.number().int().min(0).max(23).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateOrgSettingsInput = z.infer<typeof updateOrgSettingsSchema>;

export const auditEntrySchema = z.object({
  id: z.number(),
  actorId: uuidSchema.nullable(),
  actorName: z.string().nullable(),
  actorEmail: z.string().nullable(),
  action: z.string(),
  subjectType: z.string(),
  subjectId: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
  ip: z.string().nullable(),
  createdAt: z.string(),
});
export type AuditEntryView = z.infer<typeof auditEntrySchema>;

export const listAuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  actorId: uuidSchema.optional(),
  action: z.string().max(60).optional(),
  /** Inclusive, in the organisation's time zone. */
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
});
export type ListAuditQuery = z.infer<typeof listAuditQuerySchema>;

/** The days of the week, Sunday first, matching Date#getDay and weekendDays. */
export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * The scheduling calendar, for anybody signed in.
 *
 * Which days the organisation does not work is not administrative detail: a
 * calendar that shades a Sunday like a Tuesday, or a task that falls due on
 * a public holiday with no hint of it, is wrong on everyone's screen. The
 * settings themselves stay behind org.manage; this is the part the product
 * needs in order to draw a week correctly.
 */
export const workCalendarSchema = z.object({
  /** 0 = Sunday ... 6 = Saturday. */
  weekendDays: z.array(z.number().int().min(0).max(6)),
  weekStartsOn: z.number().int().min(0).max(6),
  holidays: z.array(z.object({ date: z.string(), name: z.string() })),
});
export type WorkCalendarView = z.infer<typeof workCalendarSchema>;
