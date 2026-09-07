// GENERATED FILE - DO NOT EDIT
import { z } from 'zod';
import * as Contract_0 from '../api/contracts/api.contract.js';
import * as Contract_1 from '../builder/contracts/artifact.contract.js';
import * as Contract_2 from '../catalog/contracts/part.contract.js';
import * as Contract_3 from '../cdn/contracts/release.contract.js';
import * as Contract_4 from '../cdn/contracts/site.contract.js';
import * as Contract_5 from '../cdn/contracts/edge.contract.js';
import * as Contract_6 from '../fleet/contracts/node.contract.js';
import * as Contract_7 from '../identity/contracts/identity.contract.js';

declare global {
    interface EventRegistry {
        'builder.artifact_published': z.infer<typeof Contract_1.artifactPublishedEvent['schema']>;
        'catalog.version_published': z.infer<typeof Contract_2.versionPublishedEvent['schema']>;
        'cdn.release_composed': z.infer<typeof Contract_3.releaseComposedEvent['schema']>;
        'cdn.site_deployed': z.infer<typeof Contract_4.siteDeployedEvent['schema']>;
        'artifact.created': z.infer<typeof Contract_1.artifactCrud['create']['outputSchema']>;
        'artifact.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_1.artifactCrud['update']['outputSchema']> };
        'artifact.deleted': { id: string };
        'build.created': z.infer<typeof Contract_1.buildCrud['create']['outputSchema']>;
        'build.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_1.buildCrud['update']['outputSchema']> };
        'build.deleted': { id: string };
        'part.created': z.infer<typeof Contract_2.partCrud['create']['outputSchema']>;
        'part.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_2.partCrud['update']['outputSchema']> };
        'part.deleted': { id: string };
        'partVersion.created': z.infer<typeof Contract_2.partVersionCrud['create']['outputSchema']>;
        'partVersion.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_2.partVersionCrud['update']['outputSchema']> };
        'partVersion.deleted': { id: string };
        'edge.created': z.infer<typeof Contract_5.edgeCrud['create']['outputSchema']>;
        'edge.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_5.edgeCrud['update']['outputSchema']> };
        'edge.deleted': { id: string };
        'release.created': z.infer<typeof Contract_3.releaseCrud['create']['outputSchema']>;
        'release.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_3.releaseCrud['update']['outputSchema']> };
        'release.deleted': { id: string };
        'site.created': z.infer<typeof Contract_4.siteCrud['create']['outputSchema']>;
        'site.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_4.siteCrud['update']['outputSchema']> };
        'site.deleted': { id: string };
        'node.created': z.infer<typeof Contract_6.nodeCrud['create']['outputSchema']>;
        'node.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_6.nodeCrud['update']['outputSchema']> };
        'node.deleted': { id: string };
        'group.created': z.infer<typeof Contract_6.groupCrud['create']['outputSchema']>;
        'group.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_6.groupCrud['update']['outputSchema']> };
        'group.deleted': { id: string };
        'user.created': z.infer<typeof Contract_7.userCrud['create']['outputSchema']>;
        'user.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_7.userCrud['update']['outputSchema']> };
        'user.deleted': { id: string };
        'organization.created': z.infer<typeof Contract_7.organizationCrud['create']['outputSchema']>;
        'organization.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_7.organizationCrud['update']['outputSchema']> };
        'organization.deleted': { id: string };
        'membership.created': z.infer<typeof Contract_7.membershipCrud['create']['outputSchema']>;
        'membership.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_7.membershipCrud['update']['outputSchema']> };
        'membership.deleted': { id: string };
        'role.created': z.infer<typeof Contract_7.roleCrud['create']['outputSchema']>;
        'role.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_7.roleCrud['update']['outputSchema']> };
        'role.deleted': { id: string };
        'grant.created': z.infer<typeof Contract_7.grantCrud['create']['outputSchema']>;
        'grant.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_7.grantCrud['update']['outputSchema']> };
        'grant.deleted': { id: string };
        'ticket.created': z.infer<typeof Contract_7.ticketCrud['create']['outputSchema']>;
        'ticket.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_7.ticketCrud['update']['outputSchema']> };
        'ticket.deleted': { id: string };
        'apiToken.created': z.infer<typeof Contract_7.apiTokenCrud['create']['outputSchema']>;
        'apiToken.updated': { id: string; patch: Record<string, unknown>; item: z.infer<typeof Contract_7.apiTokenCrud['update']['outputSchema']> };
        'apiToken.deleted': { id: string };
    }
}

export type { EventRegistry };
