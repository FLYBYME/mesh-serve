// GENERATED FILE - DO NOT EDIT
import { z } from 'zod';
import * as Contract_0 from '../builder/contracts/artifact.contract.js';
import * as Contract_1 from '../cdn/contracts/site.contract.js';
import * as Contract_2 from '../identity/contracts/identity.contract.js';

declare global {
    interface EventRegistry {
        'builder.artifact_published': z.infer<typeof Contract_0.artifactPublishedEvent['schema']>;
        'cdn.site_composed': z.infer<typeof Contract_1.siteComposedEvent['schema']>;
        'artifact.created': z.infer<typeof Contract_0.artifactCrud['create']['outputSchema']>;
        'artifact.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_0.artifactCrud['update']['outputSchema']> };
        'artifact.deleted': { id: string };
        'build.created': z.infer<typeof Contract_0.buildCrud['create']['outputSchema']>;
        'build.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_0.buildCrud['update']['outputSchema']> };
        'build.deleted': { id: string };
        'site.created': z.infer<typeof Contract_1.siteCrud['create']['outputSchema']>;
        'site.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_1.siteCrud['update']['outputSchema']> };
        'site.deleted': { id: string };
    }
}

export type { EventRegistry };
