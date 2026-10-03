/**
 * Validate an env file without starting anything.
 *
 * The API already refuses to boot on a bad configuration, but finding out by
 * watching a container crash-loop at two in the morning is a poor way to
 * learn that a secret is sixteen bytes. This runs the same Zod schema and
 * the same production checks against a file on disk and prints what is
 * wrong, before the first `docker compose up`.
 *
 * On the server there is no Node and no pnpm, so it ships in the API image
 * and is run through Compose:
 *
 *   docker compose -f docker-compose.prod.yml run --rm --no-deps api  *     node dist/cli/envCheck.js
 *
 * In the container the file arrives through env_file, so there is nothing to
 * read off disk: with no argument and no readable file it falls back to
 * checking the environment it was given, which is the same thing the API
 * will see a second later.
 *
 * Locally:
 *
 *   pnpm env:check                      # .env.production
 *   pnpm env:check .env.staging
 */
import { readFileSync } from 'node:fs';
import type * as Config from '../config/env';
import { isAbsolute, resolve } from 'node:path';

/*
 * Relative to where the command was typed, not to this package. pnpm sets
 * INIT_CWD to that directory, and .env.production lives at the repository
 * root, which is where somebody standing on the server will be.
 */
const root = process.env.INIT_CWD ?? process.cwd();
const given = process.argv[2];
const file = given
  ? isAbsolute(given)
    ? given
    : resolve(root, given)
  : resolve(root, '.env.production');

let contents = '';
let fromFile = true;

/** What to call the thing being checked, which may be a file or an environment. */
const subject = (): string => (fromFile ? file : 'The container environment');
try {
  contents = readFileSync(file, 'utf8');
} catch {
  /*
   * Compose has already put the variables in the environment, so an
   * unreadable file is normal inside the container and fatal outside it.
   */
  if (!process.env.DATABASE_URL) {
    console.error('Cannot read ' + file + ', and the environment is empty too.');
    console.error('Copy .env.production.example and fill it in first.');
    process.exit(1);
  }
  fromFile = false;
}

/*
 * Parsed here rather than with dotenv: this script must see exactly the file,
 * not the file plus whatever is already in the shell, or it would pass on a
 * machine where the missing value happens to be exported.
 */
const parsed: Record<string, string> = {};
for (const line of contents.split('\n')) {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) continue;
  const at = trimmed.indexOf('=');
  if (at === -1) continue;
  const key = trimmed.slice(0, at).trim();
  let value = trimmed.slice(at + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  parsed[key] = value;
}

/*
 * Reading a file: start from a clean environment, so nothing already
 * exported in the shell can paper over a gap in it. Reading the
 * environment: leave it exactly as given, because that is the thing under
 * test.
 */
if (fromFile) {
  const inherited = { PATH: process.env.PATH, HOME: process.env.HOME };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, inherited, parsed);
}
process.env.NODE_ENV = process.env.NODE_ENV ?? 'production';

async function main(): Promise<void> {
  let config: typeof Config;
  try {
    // Imported after process.env is set: the module validates on load.
    config = await import('../config/env');
  } catch (error) {
    console.error('\n' + subject() + ' is not valid:\n');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const problems = config.productionConfigErrors();
  const unsafe = config.unsafeProductionSettings();

  if (problems.length > 0) {
    console.error('\n' + subject() + ' would be refused in production:\n');
    for (const problem of problems) console.error('  - ' + problem);
  }

  if (unsafe.length > 0) {
    console.warn('\nRelaxed settings that should not be on a real server:\n');
    for (const warning of unsafe) console.warn('  - ' + warning);
  }

  if (problems.length > 0) process.exit(1);

  process.stdout.write(subject() + ' is valid.\n');
  if (unsafe.length > 0) {
    process.stdout.write('Warnings above are not fatal, but read them before deploying.\n');
  }
}

void main();
