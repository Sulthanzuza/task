import { sql } from 'drizzle-orm';
import { env } from '../../config/env';
import { withTransaction } from '../../db/client';
import { passwordResetTokens, users } from '../../db/schema';
import { generateToken, hashToken } from '../../lib/crypto';
import { logger } from '../../lib/logger';

/**
 * The first administrator, for a host with no shell.
 *
 * Render's free tier cannot run `createUser.js` on the server, so with
 * BOOTSTRAP_ADMIN_EMAIL set, a start against an empty users table creates one
 * SUPER_ADMIN with no password, and writes a single-use link to set one into
 * the log. Against a table with anybody in it, it does nothing at all: it
 * never creates a second admin and never touches anyone's password.
 *
 * Only the link's hash is stored. The raw token exists in that one log line
 * and nowhere else, so whoever can read the service's logs during those 24
 * hours can claim the account: remove both BOOTSTRAP_ADMIN_* variables once
 * signed in (docs/deploy-render.md).
 */

export const BOOTSTRAP_LINK_HOURS = 24;

/**
 * Two instances starting together on an empty database would each count no
 * users. Under this lock the second waits, then counts one, and skips. A
 * different key from the migrator's.
 */
const BOOTSTRAP_LOCK_KEY = 7_416_115_073_215_007n;

export type BootstrapResult =
  | { status: 'off' }
  | { status: 'skipped'; users: number }
  | { status: 'created'; email: string; link: string; expiresAt: string };

export async function bootstrapAdmin(now = new Date()): Promise<BootstrapResult> {
  const email = env.BOOTSTRAP_ADMIN_EMAIL;
  if (!email) return { status: 'off' };

  const token = generateToken(32);
  const expiresAt = new Date(now.getTime() + BOOTSTRAP_LINK_HOURS * 3_600_000);

  const result = await withTransaction(async (tx): Promise<BootstrapResult> => {
    // Held to the end of this transaction.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY.toString()}::bigint)`);

    // Anybody at all, deactivated accounts included: an empty table is the
    // only state in which there is no administrator to ask.
    const counted = await tx.execute(sql`SELECT count(*)::int AS n FROM users`);
    const existing = Number((counted.rows[0] as { n: number }).n);
    if (existing > 0) return { status: 'skipped', users: existing };

    const [created] = await tx
      .insert(users)
      .values({
        name: env.BOOTSTRAP_ADMIN_NAME,
        email,
        role: 'SUPER_ADMIN',
        // No password: the link below is how one is chosen.
        passwordHash: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: users.id });

    if (!created) throw new Error('Bootstrap admin insert returned no row');

    await tx.insert(passwordResetTokens).values({
      userId: created.id,
      tokenHash: hashToken(token),
      expiresAt,
      createdAt: now,
    });

    const link =
      env.WEB_ORIGIN.replace(/\/$/, '') + '/reset-password?token=' + encodeURIComponent(token);
    return { status: 'created', email, link, expiresAt: expiresAt.toISOString() };
  });

  if (result.status === 'created') {
    // The only place the raw token ever appears. A top-level field, which the
    // logger's redaction of nested *.token values leaves intact on purpose.
    logger.warn(
      { email: result.email, setPasswordLink: result.link, expiresAt: result.expiresAt },
      'Bootstrap: created the first administrator. Open setPasswordLink to choose a ' +
        'password; it works once, for ' +
        BOOTSTRAP_LINK_HOURS +
        ' hours. Then remove BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_NAME.',
    );
  } else if (result.status === 'skipped') {
    logger.info(
      { users: result.users },
      'Bootstrap skipped: users already exist. BOOTSTRAP_ADMIN_EMAIL can be removed.',
    );
  }

  return result;
}
