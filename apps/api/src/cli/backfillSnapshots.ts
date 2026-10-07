import { backfillSnapshots } from '../modules/reports/snapshots';
import { closeDatabase } from '../db/client';

/**
 * Rebuilds the overdue trend for the days before the nightly job existed.
 *
 * Run once after deploying reports, and again only if snapshots were missed
 * for a stretch. It is safe to run twice: the insert leaves existing rows
 * alone, so a day the nightly job really measured is never replaced by a
 * reconstruction of it.
 *
 *   pnpm snapshots:backfill -- --days 180
 */

function parseDays(argv: string[]): number {
  const index = argv.findIndex((arg) => arg === '--days' || arg === '-d');
  if (index === -1) return 90;

  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new Error('--days needs a whole number of days between 1 and 1000.');
  }
  return value;
}

function say(line: string): void {
  process.stdout.write(line + '\n');
}

async function main(): Promise<void> {
  const days = parseDays(process.argv.slice(2));
  const { written, from, to } = await backfillSnapshots(days);

  say('Rebuilt ' + String(written) + ' snapshot rows, ' + from + ' to ' + to + '.');
  if (written === 0) {
    say('Nothing was written: those days already have snapshots, which is the good case.');
  }
  say('Days rebuilt this way count open and overdue only; blocked and waiting-review');
  say('stay at zero, and the chart marks them estimated.');
}

main()
  .then(() => closeDatabase())
  .then(() => process.exit(0))
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await closeDatabase();
    process.exit(1);
  });
