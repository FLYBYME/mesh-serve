import { z } from 'zod';

export const roleSchema = z.object({
  key: z.string().describe('The unique identifier for the role'),
  name: z.string().describe('Display name of the role'),
  scope: z.enum(['global', 'organization']).describe('global is only ever held via identity.user.roles; organization is only ever held via identity.membership.roleKey for one org'),
  description: z.string().optional().describe('Optional description of what this role grants'),
  builtin: z.boolean().describe('Marks the roles seeding installs'),
  inherits: z.array(z.string()).describe('Inheritance is same-scope only and acyclic'),
  permissions: z.array(z.string()).default([]).describe('Contract-key patterns this role grants, e.g. "identity.*" or "serve.expose.create"; the only wildcard form is an exact "<prefix>.*" suffix match, never a bare "*"'),
}).describe('A named set of permission patterns, and a row');
