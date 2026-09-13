import { z } from 'zod';

export const roleSchema = z.object({
  key: z.string().describe('The unique identifier for the role'),
  name: z.string().describe('Display name of the role'),
  scope: z.string().describe('The scope of the role: global or scoped to an organization'),
  description: z.string().optional().describe('Optional description of what this role grants'),
  builtin: z.boolean().describe('Marks the roles seeding installs'),
  inherits: z.array(z.string()).describe('Inheritance is same-scope only and acyclic'),
}).describe('A named set of permission patterns, and a row');
