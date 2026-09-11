import '@flybyme/mesh';

declare module '@flybyme/mesh' {
    interface IMeshMeta {
        user?: {
            id: string;
            tenant_id: string;
            roles: string[];
            organizationId?: string;
            [key: string]: unknown;
        };
        tenant_id?: string;
        provisional?: boolean;
    }
}
