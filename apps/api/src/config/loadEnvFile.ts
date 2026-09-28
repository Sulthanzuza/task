import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Reads .env files into process.env for local development.
 *
 * Values already in the environment always win, so a real deployment, CI, or a test
 * that sets a variable up front is never overwritten by a file on disk.
 */

function parse(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    if (key === '') continue;

    let value = line.slice(separator + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      // Strip a trailing inline comment from an unquoted value.
      const comment = value.indexOf(' #');
      if (comment !== -1) value = value.slice(0, comment).trim();
    }
    values[key] = value;
  }
  return values;
}

/** Walk up from a starting directory looking for a .env, stopping at the workspace root. */
function findEnvFiles(startDir: string): string[] {
  const found: string[] = [];
  let dir = startDir;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) found.push(candidate);
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

export function loadEnvFiles(startDir = process.cwd()): void {
  for (const file of findEnvFiles(startDir)) {
    const values = parse(readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(values)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
