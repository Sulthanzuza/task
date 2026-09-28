import { METRIC_DEFAULTS } from '@tm/shared';
import { db, type Db } from '../../db/client';
import { holidays, orgSettings } from '../../db/schema';
import type { WorkCalendar } from '../../lib/date-utils';

export interface OrgSettings {
  timezone: string;
  weekendDays: number[];
  weekStartsOn: number;
  workHoursPerDay: number;
  noUpdateThresholdHours: number;
  blockedEscalationHours: number;
  reviewWaitingThresholdHours: number;
  overdueEscalationWorkingDays: number;
  digestTime: string;
  checkinReminderTime: string;
  quietHoursStart: number;
  quietHoursEnd: number;
}

const DEFAULTS: OrgSettings = {
  timezone: 'Asia/Kolkata',
  weekendDays: [0, 6],
  weekStartsOn: 1,
  workHoursPerDay: METRIC_DEFAULTS.workHoursPerDay,
  noUpdateThresholdHours: METRIC_DEFAULTS.noUpdateThresholdHours,
  blockedEscalationHours: METRIC_DEFAULTS.blockedEscalationHours,
  reviewWaitingThresholdHours: METRIC_DEFAULTS.reviewWaitingThresholdHours,
  overdueEscalationWorkingDays: METRIC_DEFAULTS.overdueEscalationWorkingDays,
  digestTime: '09:00:00',
  checkinReminderTime: '10:00:00',
  quietHoursStart: 20,
  quietHoursEnd: 8,
};

/**
 * Settings and holidays change rarely but are read on nearly every request,
 * so they are cached for a short while rather than fetched each time.
 */
const CACHE_TTL_MS = 30_000;
let cache: { settings: OrgSettings; holidays: string[]; expiresAt: number } | null = null;

export function clearOrgCache(): void {
  cache = null;
}

async function load(handle: Db = db): Promise<{ settings: OrgSettings; holidays: string[] }> {
  const [row] = await handle.select().from(orgSettings).limit(1);
  const holidayRows = await handle.select({ date: holidays.date }).from(holidays);

  const settings: OrgSettings = row
    ? {
        timezone: row.timezone,
        weekendDays: row.weekendDays,
        weekStartsOn: row.weekStartsOn,
        workHoursPerDay: Number(row.workHoursPerDay),
        noUpdateThresholdHours: row.noUpdateThresholdHours,
        blockedEscalationHours: row.blockedEscalationHours,
        reviewWaitingThresholdHours: row.reviewWaitingThresholdHours,
        overdueEscalationWorkingDays: row.overdueEscalationWorkingDays,
        digestTime: row.digestTime,
        checkinReminderTime: row.checkinReminderTime,
        quietHoursStart: row.quietHoursStart,
        quietHoursEnd: row.quietHoursEnd,
      }
    : DEFAULTS;

  return { settings, holidays: holidayRows.map((h) => h.date) };
}

export async function getOrgSettings(handle?: Db): Promise<OrgSettings> {
  return (await getOrgContext(handle)).settings;
}

export async function getOrgContext(
  handle?: Db,
): Promise<{ settings: OrgSettings; calendar: WorkCalendar }> {
  const now = Date.now();
  if (!cache || cache.expiresAt <= now) {
    const loaded = await load(handle);
    cache = { ...loaded, expiresAt: now + CACHE_TTL_MS };
  }
  return {
    settings: cache.settings,
    calendar: {
      timezone: cache.settings.timezone,
      weekendDays: cache.settings.weekendDays,
      holidays: new Set(cache.holidays),
      weekStartsOn: cache.settings.weekStartsOn,
    },
  };
}

/** Build a calendar without touching the database, for unit tests and the seed script. */
export function calendarFrom(settings: OrgSettings, holidayDates: string[]): WorkCalendar {
  return {
    timezone: settings.timezone,
    weekendDays: settings.weekendDays,
    holidays: new Set(holidayDates),
    weekStartsOn: settings.weekStartsOn,
  };
}

export const ORG_DEFAULTS = DEFAULTS;
