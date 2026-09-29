import { createInterface } from 'node:readline/promises';
import { eq } from 'drizzle-orm';
import { userRoleSchema, type UserRole } from '@tm/shared';
import { closeDatabase, db } from '../db/client';
import { users } from '../db/schema';
import { hashPassword } from '../lib/crypto';
import { env } from '../config/env';

/**
 * Creates the first administrator.
 *
 * Every other account is invited from the UI, which needs somebody signed in
 * to do the inviting. This is the one way in before that exists, so it is a
 * command an operator runs on the server rather than anything reachable over
 * HTTP: an unauthenticated "create the first admin" endpoint is a race with
 * whoever finds the deployment first.
 */

interface Options {
  name?: string;
  email?: string;
  role: UserRole;
  password?: string;
  timezone: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { role: 'SUPER_ADMIN', timezone: env.SEED_TIMEZONE };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case '--name':
        options.name = next;
        i += 1;
        break;
      case '--email':
        options.email = next?.trim().toLowerCase();
        i += 1;
        break;
      case '--role': {
        const parsed = userRoleSchema.safeParse(next);
        if (!parsed.success) {
          throw new Error('--role must be one of SUPER_ADMIN, TEAM_LEAD, MEMBER');
        }
        options.role = parsed.data;
        i += 1;
        break;
      }
      case '--password':
        options.password = next;
        i += 1;
        break;
      case '--timezone':
        options.timezone = next ?? options.timezone;
        i += 1;
        break;
      case '--help':
        printUsage();
        process.exit(0);
        break;
      default:
        if (arg?.startsWith('--')) throw new Error('Unknown option ' + arg);
    }
  }

  return options;
}

function printUsage(): void {
  process.stdout.write(
    [
      'Create a user directly, for the first administrator.',
      '',
      'Usage:',
      '  pnpm admin:create-user --email you@example.com --name "Your Name" --role SUPER_ADMIN',
      '',
      'Options:',
      '  --email     required',
      '  --name      required',
      '  --role      SUPER_ADMIN | TEAM_LEAD | MEMBER   (default SUPER_ADMIN)',
      '  --password  prompted for if omitted, so it stays out of your shell history',
      '  --timezone  IANA name, default ' + env.SEED_TIMEZONE,
      '',
    ].join('\n'),
  );
}

async function promptHidden(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    // Node's readline has no hidden input; warn rather than pretend.
    process.stdout.write('The password will be visible as you type it.\n');
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** The same rules the API enforces, so a CLI account is no weaker. */
function checkPassword(password: string): void {
  const problems: string[] = [];
  if (password.length < 10) problems.push('at least 10 characters');
  if (!/[a-z]/.test(password)) problems.push('a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('an uppercase letter');
  if (!/\d/.test(password)) problems.push('a number');

  if (problems.length > 0) {
    throw new Error('The password needs ' + problems.join(', ') + '.');
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!options.email || !options.name) {
    printUsage();
    throw new Error('--email and --name are required');
  }

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, options.email))
    .limit(1);

  if (existing.length > 0) {
    throw new Error('Somebody already uses ' + options.email);
  }

  const password = options.password ?? (await promptHidden('Password: '));
  checkPassword(password);

  const [created] = await db
    .insert(users)
    .values({
      name: options.name,
      email: options.email,
      role: options.role,
      timezone: options.timezone,
      passwordHash: await hashPassword(password),
      isActive: true,
    })
    .returning({ id: users.id, email: users.email, role: users.role });

  process.stdout.write(
    'Created ' + created?.email + ' as ' + created?.role + ' (' + created?.id + ')\n',
  );
}

main()
  .then(() => closeDatabase())
  .catch(async (error: unknown) => {
    process.stderr.write(String(error instanceof Error ? error.message : error) + '\n');
    await closeDatabase();
    process.exit(1);
  });
