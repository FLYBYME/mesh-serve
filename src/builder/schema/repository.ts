import { z } from 'zod';

export const repositorySchema = z.object({
  organizationId: z.string().describe('Scope, and what makes the namespace work'),
  name: z.string().describe('Unique within the organization'),
  url: z.string().describe('A reference any builder on any node can resolve; a git remote this platform knows about'),
  defaultBranch: z.string().default('HEAD').describe("'HEAD' unless said otherwise"),
  subdirectory: z.string().optional().describe('Where the descriptor lives in a monorepo'),
  credentialRef: z.string().optional().describe('Never a credential. A reference to one'),
}).describe('A git remote this platform knows about, owned by an organization');
