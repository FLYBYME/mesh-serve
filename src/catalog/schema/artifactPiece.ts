import { z } from 'zod';

/** The most one piece's base64 may be: under the api's 1 MB call, with room for the rest of it. */
export const MAX_PIECE_CHARS = 1_000_000;
/** The most pieces one file may have: 64 of ~730 KB gzipped, far over any build's file. */
export const MAX_FILE_PIECES = 64;

export const artifactPieceSchema = z.object({
  tenantId: z.string().describe('The organization importing the build'),
  uploadId: z.string().describe('The import this piece belongs to, chosen by the sender and named again by serve.artifact.import_finish'),
  path: z.string().describe('The build file this is a piece of'),
  index: z.number().int().min(0).describe('This piece\'s place in the file\'s gzipped bytes, from 0'),
  data: z.string().describe('The piece, base64'),
}).describe('One piece of one gzipped file of a build being imported, kept until the import finishes');
