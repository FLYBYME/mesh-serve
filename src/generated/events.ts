// GENERATED FILE - DO NOT EDIT
import { z } from 'zod';
import * as Contract_0 from '../builder/contracts/artifact.contract.js';
import * as Contract_1 from '../catalog/contracts/part.contract.js';
import * as Contract_2 from '../cdn/contracts/release.contract.js';
import * as Contract_3 from '../cdn/contracts/site.contract.js';
import * as Contract_4 from '../identity/contracts/identity.contract.js';

declare global {
    interface EventRegistry {
        'builder.artifact_published': z.infer<typeof Contract_0.artifactPublishedEvent['schema']>;
        'catalog.version_published': z.infer<typeof Contract_1.versionPublishedEvent['schema']>;
        'cdn.release_composed': z.infer<typeof Contract_2.releaseComposedEvent['schema']>;
        'cdn.site_deployed': z.infer<typeof Contract_3.siteDeployedEvent['schema']>;
        'artifact.created': z.infer<typeof Contract_0.artifactCrud['create']['outputSchema']>;
        'artifact.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_0.artifactCrud['update']['outputSchema']> };
        'artifact.deleted': { id: string };
        'build.created': z.infer<typeof Contract_0.buildCrud['create']['outputSchema']>;
        'build.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_0.buildCrud['update']['outputSchema']> };
        'build.deleted': { id: string };
        'part.created': z.infer<typeof Contract_1.partCrud['create']['outputSchema']>;
        'part.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_1.partCrud['update']['outputSchema']> };
        'part.deleted': { id: string };
        'partVersion.created': z.infer<typeof Contract_1.partVersionCrud['create']['outputSchema']>;
        'partVersion.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_1.partVersionCrud['update']['outputSchema']> };
        'partVersion.deleted': { id: string };
        'release.created': z.infer<typeof Contract_2.releaseCrud['create']['outputSchema']>;
        'release.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_2.releaseCrud['update']['outputSchema']> };
        'release.deleted': { id: string };
        'site.created': z.infer<typeof Contract_3.siteCrud['create']['outputSchema']>;
        'site.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_3.siteCrud['update']['outputSchema']> };
        'site.deleted': { id: string };
    }
}

export type { EventRegistry };
