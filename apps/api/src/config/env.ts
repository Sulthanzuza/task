import { z } from 'zod';
import { loadEnvFiles } from './loadEnvFile';

// Pull in .env before anything reads process.env. Real environment variables still win.
loadEnvFiles();

/** Every value the process needs, parsed once at start-up so a bad env fails loudly. */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /**
   * When set, the worker serves GET /health on this port. Container health
   * checks and the e2e runner both need a way to tell that it is alive.
   */
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().url('DATABASE_URL must be a postgres connection string'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET needs at least 32 characters'),
  /**
   * Access token lifetime, in seconds. Seconds rather than minutes so an
   * end-to-end test can force an expiry without waiting a minute for it.
   */
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(1).max(14_400).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),

  /**
   * How long a just-rotated refresh token keeps working.
   *
   * Two tabs waking together can both present the same token before either sees
   * the new one. Inside this window that is treated as one concurrent refresh
   * rather than theft, provided the chain has not moved on. Keep it short.
   */
  REFRESH_GRACE_SECONDS: z.coerce.number().int().min(0).max(300).default(30),

  /**
   * Whether this process enqueues background jobs. Off by default under test so
   * the suite does not need a queue, but a test that is specifically about
   * queueing turns it on.
   */
  JOB_QUEUE_ENABLED: z.enum(['true', 'false']).optional(),

  /**
   * Whether this process actually sends email. Off by default under test, but
   * an end-to-end run turns it on so the email can be checked for real.
   */
  MAIL_ENABLED: z.enum(['true', 'false']).optional(),

  /** How long a burst of changes to one task collapses into one email. */
  EMAIL_DEBOUNCE_SECONDS: z.coerce.number().int().min(1).max(3600).default(300),

  /** The canonical address of the web app, used to build links in emails. */
  WEB_ORIGIN: z.string().url().default('http://localhost:5174'),

  /**
   * Origins allowed to call the API with credentials, as a comma-separated list.
   * Never "*": the browser refuses a wildcard on a credentialed request anyway,
   * and an explicit list is the only safe answer when cookies are involved.
   *
   * In development the web app is same-origin behind the Vite proxy, so this
   * matters only for a deliberately cross-origin setup.
   */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim().replace(/\/$/, ''))
        .filter((origin) => origin.length > 0),
    )
    .refine((origins) => !origins.includes('*'), 'CORS_ORIGINS must not contain "*"'),

  COOKIE_DOMAIN: z.string().optional(),

  /**
   * Rate limits, per minute. Configurable because the right number depends on the
   * deployment: a shared office IP needs more headroom than a single user, and an
   * end-to-end test run needs far more than either.
   */
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(5),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
  UPLOAD_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(30),

  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  MAIL_FROM: z.string().default('Task Manager <no-reply@taskmanager.local>'),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./uploads'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('task-attachments'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().default(25 * 1024 * 1024),

  SEED_TIMEZONE: z.string().default('Asia/Kolkata'),
  SEED_PASSWORD: z.string().default('Password123!'),
});

export type Env = z.infer<typeof envSchema>;

function load(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => '  - ' + i.path.join('.') + ': ' + i.message);
    throw new Error('Invalid environment configuration:\n' + lines.join('\n'));
  }
  return parsed.data;
}

export const env: Env = load();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * How many reverse proxies sit in front of this process.
 *
 * One in production, because there is exactly one Nginx. Trusting every hop
 * would let a caller forge X-Forwarded-For and dodge the rate limiter;
 * trusting none would make every request look like it came from Nginx, so one
 * person's failed sign-ins would lock out the whole team.
 */
export const trustedProxyHops: number | false = isProduction ? 1 : false;

export const jobQueueEnabled =
  env.JOB_QUEUE_ENABLED !== undefined ? env.JOB_QUEUE_ENABLED === 'true' : !isTest;

export const mailEnabled =
  env.MAIL_ENABLED !== undefined ? env.MAIL_ENABLED === 'true' : !isTest;

/**
 * Settings that are fine in development and dangerous in production.
 *
 * These are refusals, not warnings. A deployment that starts with a default
 * secret, or with email quietly switched off, looks healthy while doing the
 * wrong thing; refusing to start is the only failure mode anyone notices.
 */
const KNOWN_DEV_SECRETS = new Set([
  'dev_access_secret_change_me_0000000000000000',
  'test_secret_used_only_in_tests_0000000000',
]);

export function productionConfigErrors(): string[] {
  if (!isProduction) return [];

  const errors: string[] = [];

  // Secrets: present, long enough, and not one of the ones in the repository.
  if (Buffer.byteLength(env.JWT_ACCESS_SECRET, 'utf8') < 32) {
    errors.push('JWT_ACCESS_SECRET must be at least 32 bytes');
  }
  if (KNOWN_DEV_SECRETS.has(env.JWT_ACCESS_SECRET)) {
    errors.push('JWT_ACCESS_SECRET is a development default and must be replaced');
  }

  // Anything credentialed must be over TLS, or the session cookie is readable
  // by anyone on the network.
  for (const origin of [env.WEB_ORIGIN, ...env.CORS_ORIGINS]) {
    if (!origin.startsWith('https://')) {
      errors.push('every allowed origin must be https, but found ' + origin);
    }
  }

  // Both default to off under test; reaching production off means alerts and
  // invitations silently do nothing.
  if (!mailEnabled) errors.push('MAIL_ENABLED must be true in production');
  if (!jobQueueEnabled) errors.push('JOB_QUEUE_ENABLED must be true in production');

  if (env.AUTH_RATE_LIMIT_PER_MINUTE > 5) {
    errors.push(
      'AUTH_RATE_LIMIT_PER_MINUTE is ' +
        env.AUTH_RATE_LIMIT_PER_MINUTE +
        '; a raised sign-in limit must not reach production',
    );
  }

  if (env.NODE_ENV === 'production' && env.STORAGE_DRIVER === 'local') {
    errors.push('STORAGE_DRIVER=local keeps uploads on a single container disk; use s3');
  }

  return errors;
}

/** Called at start-up. Throws rather than letting a misconfigured process serve. */
export function assertProductionConfig(): void {
  const errors = productionConfigErrors();
  if (errors.length === 0) return;

  const detail = errors.map((error) => '  - ' + error).join('\n');
  throw new Error('Refusing to start in production:\n' + detail);
}

/**
 * The origins CORS will accept. WEB_ORIGIN is always allowed, so a correct
 * single-origin deployment needs no extra configuration.
 */
export const allowedOrigins: string[] = [
  ...new Set([env.WEB_ORIGIN.replace(/\/$/, ''), ...env.CORS_ORIGINS]),
];

/**
 * Settings that are safe to relax for a test run but dangerous to leave relaxed.
 * Reported at start-up rather than enforced, because a deployment may have a
 * genuine reason (a whole office behind one address, say) -- but it should be a
 * decision someone made, not one that slipped through from a test environment.
 */
export function unsafeProductionSettings(): string[] {
  if (!isProduction) return [];

  const warnings: string[] = [];
  const defaults = { auth: 5, api: 300, upload: 30 };

  if (env.AUTH_RATE_LIMIT_PER_MINUTE > defaults.auth) {
    warnings.push(
      'AUTH_RATE_LIMIT_PER_MINUTE is ' +
        env.AUTH_RATE_LIMIT_PER_MINUTE +
        ', above the default of ' +
        defaults.auth +
        '; brute-force protection on sign-in is weakened',
    );
  }
  if (env.API_RATE_LIMIT_PER_MINUTE > defaults.api) {
    warnings.push(
      'API_RATE_LIMIT_PER_MINUTE is ' + env.API_RATE_LIMIT_PER_MINUTE + ', above the default of ' + defaults.api,
    );
  }
  if (env.UPLOAD_RATE_LIMIT_PER_MINUTE > defaults.upload) {
    warnings.push(
      'UPLOAD_RATE_LIMIT_PER_MINUTE is ' +
        env.UPLOAD_RATE_LIMIT_PER_MINUTE +
        ', above the default of ' +
        defaults.upload,
    );
  }
  if (env.REFRESH_GRACE_SECONDS > 60) {
    warnings.push(
      'REFRESH_GRACE_SECONDS is ' +
        env.REFRESH_GRACE_SECONDS +
        '; a long grace window widens the gap in refresh-token reuse detection',
    );
  }

  return warnings;
}
