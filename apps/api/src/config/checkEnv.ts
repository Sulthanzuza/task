/**
 * Validate an env file without starting anything.
 *
 * The API already refuses to boot on a bad configuration, but finding out by
 * watching a container crash-loop at two in the morning is a poor way to
 * learn that a secret is sixteen bytes. This runs the same Zod schema and
 * the same production checks against a file on disk and prints what is
 * wrong, before the first `docker compose up`.
 *
 *   pnpm env:check                      # .env.production
 *   pnpm env:check .env.staging
 */
import { readFileSync } from 'node:fs';
import type * as Config from './env';
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

let contents: string;
try {
  contents = readFileSync(file, 'utf8');
} catch {
  console.error('Cannot read ' + file);
  console.error('Copy .env.production.example and fill it in first.');
  process.exit(1);
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

// A fresh environment, so nothing already exported can paper over a gap.
const inherited = { PATH: process.env.PATH, HOME: process.env.HOME };
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, inherited, parsed);
process.env.NODE_ENV = parsed.NODE_ENV ?? 'production';

async function main(): Promise<void> {
  let config: typeof Config;
  try {
    // Imported after process.env is set: the module validates on load.
    config = await import('./env');
  } catch (error) {
    console.error('\n' + file + ' is not valid:\n');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const problems = config.productionConfigErrors();
  const unsafe = config.unsafeProductionSettings();

  if (problems.length > 0) {
    console.error('\n' + file + ' would be refused in production:\n');
    for (const problem of problems) console.error('  - ' + problem);
  }

  if (unsafe.length > 0) {
    console.warn('\nRelaxed settings that should not be on a real server:\n');
    for (const warning of unsafe) console.warn('  - ' + warning);
  }

  if (problems.length > 0) process.exit(1);

  process.stdout.write(file + ' is valid.\n');
  if (unsafe.length > 0) {
    process.stdout.write('Warnings above are not fatal, but read them before deploying.\n');
  }
}

void main();
