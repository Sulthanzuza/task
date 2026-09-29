import { z } from 'zod';
import { loadEnvFiles } from './loadEnvFile';

// Pull in .env before anything reads process.env. Real environment variables still win.
loadEnvFiles();

/** Every value the process needs, parsed once at start-up so a bad env fails loudly. */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().url('DATABASE_URL must be a postgres connection string'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET needs at least 32 characters'),
  JWT_ACCESS_TTL_MINUTES: z.coerce.number().int().min(1).max(240).default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),

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
 * The origins CORS will accept. WEB_ORIGIN is always allowed, so a correct
 * single-origin deployment needs no extra configuration.
 */
export const allowedOrigins: string[] = [
  ...new Set([env.WEB_ORIGIN.replace(/\/$/, ''), ...env.CORS_ORIGINS]),
];
