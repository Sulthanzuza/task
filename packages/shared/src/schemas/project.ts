import { z } from 'zod';
import { projectStatusSchema } from '../enums';
import { booleanQuerySchema, cursorPaginationSchema, projectKeySchema, uuidSchema } from './common';

export const projectSchema = z.object({
  id: uuidSchema,
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: projectStatusSchema,
  teamId: uuidSchema,
  createdBy: uuidSchema,
  createdAt: z.string(),
  archivedAt: z.string().nullable(),
});
export type Project = z.infer<typeof projectSchema>;

export const createProjectSchema = z.object({
  // The key is immutable once set, because task keys are printed everywhere.
  key: projectKeySchema,
  name: z.string().trim().min(2, 'Enter a project name').max(160),
  description: z.string().trim().max(5000).optional(),
  teamId: uuidSchema,
  status: projectStatusSchema.default('ACTIVE'),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(2).max(160).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    status: projectStatusSchema.optional(),
    teamId: uuidSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const listProjectsQuerySchema = cursorPaginationSchema.extend({
  teamId: uuidSchema.optional(),
  archived: booleanQuerySchema,
  q: z.string().trim().min(1).max(100).optional(),
});
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;

export const labelSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema.nullable(),
  name: z.string(),
  color: z.string(),
});
export type Label = z.infer<typeof labelSchema>;

export const createLabelSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #2563eb')
    .default('#64748b'),
  projectId: uuidSchema.nullable().optional(),
});
export type CreateLabelInput = z.infer<typeof createLabelSchema>;
