import { z } from 'zod';

export const descriptorSchema = z.object({
  key: z.string().describe('Contract key'),
  domain: z.string().describe('Domain of the contract'),
  action: z.string().describe('Action of the contract'),
  description: z.string().optional().describe('Human-readable description'),
  method: z.string().describe('HTTP method'),
  path: z.string().describe('URL path'),
  gate: z.any().describe('The resolved gate'),
  inputSchema: z.any().describe('Zod schema for input'),
  outputSchema: z.any().describe('Zod schema for output'),
  destructive: z.boolean().describe('What makes a UI ask before doing; declaration rather than guess from verb'),
  stream: z.boolean().describe('Whether it streams output'),
  declaredErrors: z.array(z.string()).describe('List of possible error codes'),
}).describe('The descriptor a site publishes for a call');
