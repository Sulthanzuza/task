import { z } from 'zod';
import { uuidSchema } from './common';
import { userSummarySchema } from './user';

export const teamSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  leadId: uuidSchema.nullable(),
  createdAt: z.string(),
});
export type Team = z.infer<typeof teamSchema>;

export const teamDetailSchema = teamSchema.extend({
  lead: userSummarySchema.nullable(),
  members: z.array(userSummarySchema),
});
export type TeamDetail = z.infer<typeof teamDetailSchema>;

export const createTeamSchema = z.object({
  name: z.string().trim().min(2, 'Enter a team name').max(120),
  leadId: uuidSchema.nullable().optional(),
});
export type CreateTeamInput = z.infer<typeof createTeamSchema>;

export const updateTeamSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    leadId: uuidSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;

export const teamMemberSchema = z.object({ userId: uuidSchema });
export type TeamMemberInput = z.infer<typeof teamMemberSchema>;
