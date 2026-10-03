import { z } from 'zod';
import { uuidSchema } from './common';
import { userSummarySchema } from './user';

export const teamSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  leadId: uuidSchema.nullable(),
  /**
   * A team that exists for the machinery rather than for people.
   *
   * Its work is left out of the dashboard pickers, the daily digest and the
   * alerts, so the deploy pipeline's smoke traffic does not move the numbers
   * a lead reads or page anybody at three in the morning. It is an ordinary
   * team for every permission question.
   */
  isInternal: z.boolean(),
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
  isInternal: z.boolean().optional(),
});
export type CreateTeamInput = z.infer<typeof createTeamSchema>;

export const updateTeamSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    leadId: uuidSchema.nullable().optional(),
    isInternal: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;

export const teamMemberSchema = z.object({ userId: uuidSchema });
export type TeamMemberInput = z.infer<typeof teamMemberSchema>;
