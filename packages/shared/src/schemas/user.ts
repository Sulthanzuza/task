import { z } from 'zod';
import { userRoleSchema } from '../enums';
import { emailSchema } from './auth';
import { booleanQuerySchema, cursorPaginationSchema, uuidSchema } from './common';

export const userSummarySchema = z.object({
  id: uuidSchema,
  name: z.string(),
  email: z.string(),
  role: userRoleSchema,
  avatarUrl: z.string().nullable(),
  isActive: z.boolean(),
});
export type UserSummary = z.infer<typeof userSummarySchema>;

export const userDetailSchema = userSummarySchema.extend({
  timezone: z.string(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
  teamIds: z.array(uuidSchema),
});
export type UserDetail = z.infer<typeof userDetailSchema>;

export const createUserSchema = z.object({
  name: z.string().trim().min(2, 'Enter a name').max(120),
  email: emailSchema,
  role: userRoleSchema,
  timezone: z.string().min(1).default('Asia/Kolkata'),
  teamIds: z.array(uuidSchema).default([]),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    role: userRoleSchema.optional(),
    timezone: z.string().min(1).optional(),
    avatarUrl: z.string().url().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const listUsersQuerySchema = cursorPaginationSchema.extend({
  teamId: uuidSchema.optional(),
  active: booleanQuerySchema,
  q: z.string().trim().min(1).max(100).optional(),
  role: userRoleSchema.optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

/**
 * A one-time link an admin hands over by hand: to set a first password (an
 * invitation) or a new one (a reset). Single use, and it expires. Returned
 * whether or not email is on, so a lost email never strands anybody.
 */
export const issuedLinkSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string(),
});
export type IssuedLink = z.infer<typeof issuedLinkSchema>;

/** POST /users: the new person, and the link that lets them in. */
export type InvitedUser = UserDetail & { invite: IssuedLink };

/** POST /users/:id/resend-invite. emailed is false when email is turned off. */
export interface ResentInvite {
  email: string;
  emailed: boolean;
  invite: IssuedLink;
}
