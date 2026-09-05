// GENERATED FILE - DO NOT EDIT
import { z } from 'zod';
import * as Contract_0 from '../builder/contracts/artifact.contract.js';
import * as Contract_1 from '../cdn/contracts/site.contract.js';
import * as Contract_2 from '../identity/contracts/identity.contract.js';

declare global {
    interface IServiceToolRegistry {
        'builder.build_start': { params: z.input<typeof Contract_0.buildStartContract['inputSchema']>, returns: z.infer<typeof Contract_0.buildStartContract['outputSchema']> };
        'builder.get_artifact': { params: z.input<typeof Contract_0.getArtifactContract['inputSchema']>, returns: z.infer<typeof Contract_0.getArtifactContract['outputSchema']> };
        'builder.artifact_blob': { params: z.input<typeof Contract_0.artifactBlobContract['inputSchema']>, returns: z.infer<typeof Contract_0.artifactBlobContract['outputSchema']> };
        'artifact.create': { params: z.input<typeof Contract_0.artifactCrud['create']['inputSchema']>, returns: z.infer<typeof Contract_0.artifactCrud['create']['outputSchema']> };
        'artifact.find': { params: z.input<typeof Contract_0.artifactCrud['find']['inputSchema']>, returns: z.infer<typeof Contract_0.artifactCrud['find']['outputSchema']> };
        'artifact.find_one': { params: z.input<typeof Contract_0.artifactCrud['findOne']['inputSchema']>, returns: z.infer<typeof Contract_0.artifactCrud['findOne']['outputSchema']> };
        'artifact.count': { params: z.input<typeof Contract_0.artifactCrud['count']['inputSchema']>, returns: z.infer<typeof Contract_0.artifactCrud['count']['outputSchema']> };
        'artifact.get': { params: z.input<typeof Contract_0.artifactCrud['get']['inputSchema']>, returns: z.infer<typeof Contract_0.artifactCrud['get']['outputSchema']> };
        'artifact.resolve': { params: z.input<typeof Contract_0.artifactCrud['resolve']['inputSchema']>, returns: z.infer<typeof Contract_0.artifactCrud['resolve']['outputSchema']> };
        'artifact.update': { params: z.input<typeof Contract_0.artifactCrud['update']['inputSchema']>, returns: z.infer<typeof Contract_0.artifactCrud['update']['outputSchema']> };
        'artifact.delete': { params: z.input<typeof Contract_0.artifactCrud['delete']['inputSchema']>, returns: z.infer<typeof Contract_0.artifactCrud['delete']['outputSchema']> };
        'build.create': { params: z.input<typeof Contract_0.buildCrud['create']['inputSchema']>, returns: z.infer<typeof Contract_0.buildCrud['create']['outputSchema']> };
        'build.find': { params: z.input<typeof Contract_0.buildCrud['find']['inputSchema']>, returns: z.infer<typeof Contract_0.buildCrud['find']['outputSchema']> };
        'build.find_one': { params: z.input<typeof Contract_0.buildCrud['findOne']['inputSchema']>, returns: z.infer<typeof Contract_0.buildCrud['findOne']['outputSchema']> };
        'build.count': { params: z.input<typeof Contract_0.buildCrud['count']['inputSchema']>, returns: z.infer<typeof Contract_0.buildCrud['count']['outputSchema']> };
        'build.get': { params: z.input<typeof Contract_0.buildCrud['get']['inputSchema']>, returns: z.infer<typeof Contract_0.buildCrud['get']['outputSchema']> };
        'build.resolve': { params: z.input<typeof Contract_0.buildCrud['resolve']['inputSchema']>, returns: z.infer<typeof Contract_0.buildCrud['resolve']['outputSchema']> };
        'build.update': { params: z.input<typeof Contract_0.buildCrud['update']['inputSchema']>, returns: z.infer<typeof Contract_0.buildCrud['update']['outputSchema']> };
        'build.delete': { params: z.input<typeof Contract_0.buildCrud['delete']['inputSchema']>, returns: z.infer<typeof Contract_0.buildCrud['delete']['outputSchema']> };
        'cdn.site_compose': { params: z.input<typeof Contract_1.siteComposeContract['inputSchema']>, returns: z.infer<typeof Contract_1.siteComposeContract['outputSchema']> };
        'site.create': { params: z.input<typeof Contract_1.siteCrud['create']['inputSchema']>, returns: z.infer<typeof Contract_1.siteCrud['create']['outputSchema']> };
        'site.find': { params: z.input<typeof Contract_1.siteCrud['find']['inputSchema']>, returns: z.infer<typeof Contract_1.siteCrud['find']['outputSchema']> };
        'site.find_one': { params: z.input<typeof Contract_1.siteCrud['findOne']['inputSchema']>, returns: z.infer<typeof Contract_1.siteCrud['findOne']['outputSchema']> };
        'site.count': { params: z.input<typeof Contract_1.siteCrud['count']['inputSchema']>, returns: z.infer<typeof Contract_1.siteCrud['count']['outputSchema']> };
        'site.get': { params: z.input<typeof Contract_1.siteCrud['get']['inputSchema']>, returns: z.infer<typeof Contract_1.siteCrud['get']['outputSchema']> };
        'site.resolve': { params: z.input<typeof Contract_1.siteCrud['resolve']['inputSchema']>, returns: z.infer<typeof Contract_1.siteCrud['resolve']['outputSchema']> };
        'site.update': { params: z.input<typeof Contract_1.siteCrud['update']['inputSchema']>, returns: z.infer<typeof Contract_1.siteCrud['update']['outputSchema']> };
        'site.delete': { params: z.input<typeof Contract_1.siteCrud['delete']['inputSchema']>, returns: z.infer<typeof Contract_1.siteCrud['delete']['outputSchema']> };
        'identity.ticket_issue': { params: z.input<typeof Contract_2.ticketIssueContract['inputSchema']>, returns: z.infer<typeof Contract_2.ticketIssueContract['outputSchema']> };
        'identity.ticket_validate': { params: z.input<typeof Contract_2.ticketValidateContract['inputSchema']>, returns: z.infer<typeof Contract_2.ticketValidateContract['outputSchema']> };
        'identity.ticket_revoke': { params: z.input<typeof Contract_2.ticketRevokeContract['inputSchema']>, returns: z.infer<typeof Contract_2.ticketRevokeContract['outputSchema']> };
        'identity.revocations_since': { params: z.input<typeof Contract_2.revocationsSinceContract['inputSchema']>, returns: z.infer<typeof Contract_2.revocationsSinceContract['outputSchema']> };
        'identity.whoami': { params: z.input<typeof Contract_2.whoamiContract['inputSchema']>, returns: z.infer<typeof Contract_2.whoamiContract['outputSchema']> };
        'identity.register': { params: z.input<typeof Contract_2.registerContract['inputSchema']>, returns: z.infer<typeof Contract_2.registerContract['outputSchema']> };
        'identity.permits': { params: z.input<typeof Contract_2.permitsContract['inputSchema']>, returns: z.infer<typeof Contract_2.permitsContract['outputSchema']> };
    }
}

export type { IServiceToolRegistry };
