// GENERATED FILE - DO NOT EDIT
import { z } from 'zod';
import * as Contract_0 from '../api/contracts/api.contract.js';
import * as Contract_1 from '../builder/contracts/artifact.contract.js';
import * as Contract_2 from '../catalog/contracts/part.contract.js';
import * as Contract_3 from '../cdn/contracts/release.contract.js';
import * as Contract_4 from '../cdn/contracts/site.contract.js';
import * as Contract_5 from '../identity/contracts/identity.contract.js';

declare global {
    interface IServiceToolRegistry {
        'api.describe': { params: z.input<typeof Contract_0.describeContract['inputSchema']>, returns: z.infer<typeof Contract_0.describeContract['outputSchema']> };
        'builder.build_start': { params: z.input<typeof Contract_1.buildStartContract['inputSchema']>, returns: z.infer<typeof Contract_1.buildStartContract['outputSchema']> };
        'builder.get_artifact': { params: z.input<typeof Contract_1.getArtifactContract['inputSchema']>, returns: z.infer<typeof Contract_1.getArtifactContract['outputSchema']> };
        'builder.artifact_blob': { params: z.input<typeof Contract_1.artifactBlobContract['inputSchema']>, returns: z.infer<typeof Contract_1.artifactBlobContract['outputSchema']> };
        'artifact.create': { params: z.input<typeof Contract_1.artifactCrud['create']['inputSchema']>, returns: z.infer<typeof Contract_1.artifactCrud['create']['outputSchema']> };
        'artifact.find': { params: z.input<typeof Contract_1.artifactCrud['find']['inputSchema']>, returns: z.infer<typeof Contract_1.artifactCrud['find']['outputSchema']> };
        'artifact.find_one': { params: z.input<typeof Contract_1.artifactCrud['findOne']['inputSchema']>, returns: z.infer<typeof Contract_1.artifactCrud['findOne']['outputSchema']> };
        'artifact.count': { params: z.input<typeof Contract_1.artifactCrud['count']['inputSchema']>, returns: z.infer<typeof Contract_1.artifactCrud['count']['outputSchema']> };
        'artifact.get': { params: z.input<typeof Contract_1.artifactCrud['get']['inputSchema']>, returns: z.infer<typeof Contract_1.artifactCrud['get']['outputSchema']> };
        'artifact.resolve': { params: z.input<typeof Contract_1.artifactCrud['resolve']['inputSchema']>, returns: z.infer<typeof Contract_1.artifactCrud['resolve']['outputSchema']> };
        'artifact.update': { params: z.input<typeof Contract_1.artifactCrud['update']['inputSchema']>, returns: z.infer<typeof Contract_1.artifactCrud['update']['outputSchema']> };
        'artifact.delete': { params: z.input<typeof Contract_1.artifactCrud['delete']['inputSchema']>, returns: z.infer<typeof Contract_1.artifactCrud['delete']['outputSchema']> };
        'build.create': { params: z.input<typeof Contract_1.buildCrud['create']['inputSchema']>, returns: z.infer<typeof Contract_1.buildCrud['create']['outputSchema']> };
        'build.find': { params: z.input<typeof Contract_1.buildCrud['find']['inputSchema']>, returns: z.infer<typeof Contract_1.buildCrud['find']['outputSchema']> };
        'build.find_one': { params: z.input<typeof Contract_1.buildCrud['findOne']['inputSchema']>, returns: z.infer<typeof Contract_1.buildCrud['findOne']['outputSchema']> };
        'build.count': { params: z.input<typeof Contract_1.buildCrud['count']['inputSchema']>, returns: z.infer<typeof Contract_1.buildCrud['count']['outputSchema']> };
        'build.get': { params: z.input<typeof Contract_1.buildCrud['get']['inputSchema']>, returns: z.infer<typeof Contract_1.buildCrud['get']['outputSchema']> };
        'build.resolve': { params: z.input<typeof Contract_1.buildCrud['resolve']['inputSchema']>, returns: z.infer<typeof Contract_1.buildCrud['resolve']['outputSchema']> };
        'build.update': { params: z.input<typeof Contract_1.buildCrud['update']['inputSchema']>, returns: z.infer<typeof Contract_1.buildCrud['update']['outputSchema']> };
        'build.delete': { params: z.input<typeof Contract_1.buildCrud['delete']['inputSchema']>, returns: z.infer<typeof Contract_1.buildCrud['delete']['outputSchema']> };
        'catalog.publish': { params: z.input<typeof Contract_2.publishContract['inputSchema']>, returns: z.infer<typeof Contract_2.publishContract['outputSchema']> };
        'catalog.resolve': { params: z.input<typeof Contract_2.resolveContract['inputSchema']>, returns: z.infer<typeof Contract_2.resolveContract['outputSchema']> };
        'part.create': { params: z.input<typeof Contract_2.partCrud['create']['inputSchema']>, returns: z.infer<typeof Contract_2.partCrud['create']['outputSchema']> };
        'part.find': { params: z.input<typeof Contract_2.partCrud['find']['inputSchema']>, returns: z.infer<typeof Contract_2.partCrud['find']['outputSchema']> };
        'part.find_one': { params: z.input<typeof Contract_2.partCrud['findOne']['inputSchema']>, returns: z.infer<typeof Contract_2.partCrud['findOne']['outputSchema']> };
        'part.count': { params: z.input<typeof Contract_2.partCrud['count']['inputSchema']>, returns: z.infer<typeof Contract_2.partCrud['count']['outputSchema']> };
        'part.get': { params: z.input<typeof Contract_2.partCrud['get']['inputSchema']>, returns: z.infer<typeof Contract_2.partCrud['get']['outputSchema']> };
        'part.resolve': { params: z.input<typeof Contract_2.partCrud['resolve']['inputSchema']>, returns: z.infer<typeof Contract_2.partCrud['resolve']['outputSchema']> };
        'part.update': { params: z.input<typeof Contract_2.partCrud['update']['inputSchema']>, returns: z.infer<typeof Contract_2.partCrud['update']['outputSchema']> };
        'part.delete': { params: z.input<typeof Contract_2.partCrud['delete']['inputSchema']>, returns: z.infer<typeof Contract_2.partCrud['delete']['outputSchema']> };
        'partVersion.create': { params: z.input<typeof Contract_2.partVersionCrud['create']['inputSchema']>, returns: z.infer<typeof Contract_2.partVersionCrud['create']['outputSchema']> };
        'partVersion.find': { params: z.input<typeof Contract_2.partVersionCrud['find']['inputSchema']>, returns: z.infer<typeof Contract_2.partVersionCrud['find']['outputSchema']> };
        'partVersion.find_one': { params: z.input<typeof Contract_2.partVersionCrud['findOne']['inputSchema']>, returns: z.infer<typeof Contract_2.partVersionCrud['findOne']['outputSchema']> };
        'partVersion.count': { params: z.input<typeof Contract_2.partVersionCrud['count']['inputSchema']>, returns: z.infer<typeof Contract_2.partVersionCrud['count']['outputSchema']> };
        'partVersion.get': { params: z.input<typeof Contract_2.partVersionCrud['get']['inputSchema']>, returns: z.infer<typeof Contract_2.partVersionCrud['get']['outputSchema']> };
        'partVersion.resolve': { params: z.input<typeof Contract_2.partVersionCrud['resolve']['inputSchema']>, returns: z.infer<typeof Contract_2.partVersionCrud['resolve']['outputSchema']> };
        'partVersion.update': { params: z.input<typeof Contract_2.partVersionCrud['update']['inputSchema']>, returns: z.infer<typeof Contract_2.partVersionCrud['update']['outputSchema']> };
        'partVersion.delete': { params: z.input<typeof Contract_2.partVersionCrud['delete']['inputSchema']>, returns: z.infer<typeof Contract_2.partVersionCrud['delete']['outputSchema']> };
        'cdn.compose': { params: z.input<typeof Contract_3.composeContract['inputSchema']>, returns: z.infer<typeof Contract_3.composeContract['outputSchema']> };
        'cdn.deploy': { params: z.input<typeof Contract_3.deployContract['inputSchema']>, returns: z.infer<typeof Contract_3.deployContract['outputSchema']> };
        'release.create': { params: z.input<typeof Contract_3.releaseCrud['create']['inputSchema']>, returns: z.infer<typeof Contract_3.releaseCrud['create']['outputSchema']> };
        'release.find': { params: z.input<typeof Contract_3.releaseCrud['find']['inputSchema']>, returns: z.infer<typeof Contract_3.releaseCrud['find']['outputSchema']> };
        'release.find_one': { params: z.input<typeof Contract_3.releaseCrud['findOne']['inputSchema']>, returns: z.infer<typeof Contract_3.releaseCrud['findOne']['outputSchema']> };
        'release.count': { params: z.input<typeof Contract_3.releaseCrud['count']['inputSchema']>, returns: z.infer<typeof Contract_3.releaseCrud['count']['outputSchema']> };
        'release.get': { params: z.input<typeof Contract_3.releaseCrud['get']['inputSchema']>, returns: z.infer<typeof Contract_3.releaseCrud['get']['outputSchema']> };
        'release.resolve': { params: z.input<typeof Contract_3.releaseCrud['resolve']['inputSchema']>, returns: z.infer<typeof Contract_3.releaseCrud['resolve']['outputSchema']> };
        'release.update': { params: z.input<typeof Contract_3.releaseCrud['update']['inputSchema']>, returns: z.infer<typeof Contract_3.releaseCrud['update']['outputSchema']> };
        'release.delete': { params: z.input<typeof Contract_3.releaseCrud['delete']['inputSchema']>, returns: z.infer<typeof Contract_3.releaseCrud['delete']['outputSchema']> };
        'cdn.resolve_site': { params: z.input<typeof Contract_3.resolveSiteContract['inputSchema']>, returns: z.infer<typeof Contract_3.resolveSiteContract['outputSchema']> };
        'site.create': { params: z.input<typeof Contract_4.siteCrud['create']['inputSchema']>, returns: z.infer<typeof Contract_4.siteCrud['create']['outputSchema']> };
        'site.find': { params: z.input<typeof Contract_4.siteCrud['find']['inputSchema']>, returns: z.infer<typeof Contract_4.siteCrud['find']['outputSchema']> };
        'site.find_one': { params: z.input<typeof Contract_4.siteCrud['findOne']['inputSchema']>, returns: z.infer<typeof Contract_4.siteCrud['findOne']['outputSchema']> };
        'site.count': { params: z.input<typeof Contract_4.siteCrud['count']['inputSchema']>, returns: z.infer<typeof Contract_4.siteCrud['count']['outputSchema']> };
        'site.get': { params: z.input<typeof Contract_4.siteCrud['get']['inputSchema']>, returns: z.infer<typeof Contract_4.siteCrud['get']['outputSchema']> };
        'site.resolve': { params: z.input<typeof Contract_4.siteCrud['resolve']['inputSchema']>, returns: z.infer<typeof Contract_4.siteCrud['resolve']['outputSchema']> };
        'site.update': { params: z.input<typeof Contract_4.siteCrud['update']['inputSchema']>, returns: z.infer<typeof Contract_4.siteCrud['update']['outputSchema']> };
        'site.delete': { params: z.input<typeof Contract_4.siteCrud['delete']['inputSchema']>, returns: z.infer<typeof Contract_4.siteCrud['delete']['outputSchema']> };
        'identity.ticket_issue': { params: z.input<typeof Contract_5.ticketIssueContract['inputSchema']>, returns: z.infer<typeof Contract_5.ticketIssueContract['outputSchema']> };
        'identity.ticket_validate': { params: z.input<typeof Contract_5.ticketValidateContract['inputSchema']>, returns: z.infer<typeof Contract_5.ticketValidateContract['outputSchema']> };
        'identity.ticket_revoke': { params: z.input<typeof Contract_5.ticketRevokeContract['inputSchema']>, returns: z.infer<typeof Contract_5.ticketRevokeContract['outputSchema']> };
        'identity.revocations_since': { params: z.input<typeof Contract_5.revocationsSinceContract['inputSchema']>, returns: z.infer<typeof Contract_5.revocationsSinceContract['outputSchema']> };
        'identity.whoami': { params: z.input<typeof Contract_5.whoamiContract['inputSchema']>, returns: z.infer<typeof Contract_5.whoamiContract['outputSchema']> };
        'identity.register': { params: z.input<typeof Contract_5.registerContract['inputSchema']>, returns: z.infer<typeof Contract_5.registerContract['outputSchema']> };
        'identity.permits': { params: z.input<typeof Contract_5.permitsContract['inputSchema']>, returns: z.infer<typeof Contract_5.permitsContract['outputSchema']> };
    }
}

export type { IServiceToolRegistry };
