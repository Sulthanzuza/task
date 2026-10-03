import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { boolean, index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { citext, createdAt, tz, updatedAt, userRoleEnum } from './columns';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: citext('email').notNull().unique(),
    passwordHash: text('password_hash'),
    role: userRoleEnum('role').notNull().default('MEMBER'),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    avatarUrl: text('avatar_url'),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: tz('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('users_active_idx').on(t.isActive)],
);

/** One row per refresh token. Only a hash is stored, so a database leak cannot log anyone in. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refreshTokenHash: text('refresh_token_hash').notNull().unique(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    expiresAt: tz('expires_at').notNull(),
    /** Set the moment this token is rotated away or the session is revoked. */
    revokedAt: tz('revoked_at'),
    /**
     * The session that replaced this one when it was rotated.
     *
     * Following this chain is what separates two tabs refreshing at the same
     * instant from a genuinely stolen token: a concurrent refresh presents the
     * token that was rotated a moment ago and whose successor is still live,
     * while a replay presents one whose chain has already moved on.
     */
    replacedBySessionId: uuid('replaced_by_session_id').references((): AnyPgColumn => sessions.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expiry_idx').on(t.expiresAt)],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: tz('expires_at').notNull(),
    usedAt: tz('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('password_reset_user_idx').on(t.userId)],
);

export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  // A lead can be unset while the team is being reorganised; deleting a user must not
  // silently orphan their team, so this is RESTRICT at the user end.
  leadId: uuid('lead_id').references(() => users.id, { onDelete: 'restrict' }),
  /**
   * A team that exists for the machinery, not for people.
   *
   * The smoke test signs in after every deploy and creates a task, moves it
   * and deletes it. Without this flag that traffic lands in the dashboard
   * averages, the daily digest and the overdue alerts, so the numbers a lead
   * reads drift with how often the deploy pipeline runs, and somebody gets
   * paged about a task that only ever existed for ninety seconds.
   *
   * Excluded from every aggregate and every notification. Never from
   * permissions: an internal team is a normal team to authorize().
   */
  isInternal: boolean('is_internal').notNull().default(false),
  createdAt: createdAt(),
});

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    index('team_members_user_idx').on(t.userId),
  ],
);
