import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentSecurityPolicy, CdnService } from '../../../src/cdn/cdn.service.js';

describe('Content Security Policy (CSP) generation', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        delete process.env.PUBLIC_SCHEME;
        delete process.env.PUBLIC_API_PORT;
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    const sampleSite = {
        mcpHost: 'mcp.mesh.example.com',
    };

    describe('directive structure and default-src formatting', () => {
        it('starts with default-src \'self\' and separates directives with semicolons', () => {
            const csp = contentSecurityPolicy(sampleSite, 'api.mesh.example.com', "'sha256-abc123'");
            const directives = csp.split('; ');

            expect(directives[0]).toBe("default-src 'self'");
            expect(csp).toMatch(/^default-src 'self';/);
        });

        it('includes all standard security directives in expected order', () => {
            const csp = contentSecurityPolicy(sampleSite, 'api.mesh.example.com', "'sha256-hash'");
            const directives = csp.split('; ');

            expect(directives).toHaveLength(6);
            expect(directives[0]).toBe("default-src 'self'");
            expect(directives[1]).toMatch(/^script-src 'self'/);
            expect(directives[2]).toBe("style-src 'self' 'unsafe-inline'");
            expect(directives[3]).toMatch(/^connect-src 'self'/);
            expect(directives[4]).toBe("img-src 'self' data: https:");
            expect(directives[5]).toBe("font-src 'self'");
        });

        it('can be generated via CdnService instance method', () => {
            const cdnService = new CdnService();
            const fullSite = {
                host: 'mesh.example.com',
                mcpHost: 'mcp.mesh.example.com',
                tenantId: 'tenant-1',
                application: 'app',
                policy: {},
                theme: {},
                title: 'App',
                description: '',
                indexable: true,
                maintenance: false,
            };
            const csp = cdnService.contentSecurityPolicy(fullSite, 'api.mesh.example.com', "'sha256-hash'");

            expect(csp).toContain("default-src 'self'");
            expect(csp).toContain("script-src 'self' 'sha256-hash'");
        });
    });

    describe('script-src formatting with script hashes', () => {
        it('formats script-src with individual single quotes around multiple hashes', () => {
            const hashes = "'sha256-importmaphash123=' 'sha256-bootmodulehash456='";
            const csp = contentSecurityPolicy(sampleSite, 'api.mesh.example.com', hashes);

            expect(csp).toContain("script-src 'self' 'sha256-importmaphash123=' 'sha256-bootmodulehash456='");
        });

        it('formats script-src with a single quoted hash', () => {
            const hash = "'sha256-singlehash789='";
            const csp = contentSecurityPolicy(sampleSite, 'api.mesh.example.com', hash);

            expect(csp).toContain("script-src 'self' 'sha256-singlehash789='");
        });

        it('formats script-src without trailing space issues when hashes string is empty', () => {
            const csp = contentSecurityPolicy(sampleSite, 'api.mesh.example.com', '');

            expect(csp).toContain("script-src 'self' ");
        });
    });

    describe('connect-src synthesis', () => {
        describe('default environment (HTTPS, standard ports)', () => {
            it('synthesizes connect-src with HTTPS API origin and HTTPS/WSS MCP origins', () => {
                const csp = contentSecurityPolicy(sampleSite, 'api.mesh.example.com', "'sha256-test'");

                expect(csp).toContain(
                    "connect-src 'self' https://api.mesh.example.com https://mcp.mesh.example.com wss://mcp.mesh.example.com"
                );
            });
        });

        describe('HTTP scheme configuration (PUBLIC_SCHEME=http)', () => {
            beforeEach(() => {
                process.env.PUBLIC_SCHEME = 'http';
            });

            it('synthesizes connect-src with HTTP API origin and HTTP/WS MCP origins', () => {
                const csp = contentSecurityPolicy(sampleSite, 'api.mesh.local', "'sha256-test'");

                expect(csp).toContain(
                    "connect-src 'self' http://api.mesh.local http://mcp.mesh.example.com ws://mcp.mesh.example.com"
                );
            });
        });

        describe('custom API port configuration (PUBLIC_API_PORT)', () => {
            it('appends custom port to API origin while keeping MCP origin on standard port (HTTPS)', () => {
                process.env.PUBLIC_API_PORT = '8443';
                const csp = contentSecurityPolicy(sampleSite, 'api.mesh.example.com', "'sha256-test'");

                expect(csp).toContain(
                    "connect-src 'self' https://api.mesh.example.com:8443 https://mcp.mesh.example.com wss://mcp.mesh.example.com"
                );
            });

            it('appends custom port to API origin in HTTP mode (local dev)', () => {
                process.env.PUBLIC_SCHEME = 'http';
                process.env.PUBLIC_API_PORT = '3001';
                const csp = contentSecurityPolicy(sampleSite, 'localhost', "'sha256-test'");

                expect(csp).toContain(
                    "connect-src 'self' http://localhost:3001 http://mcp.mesh.example.com ws://mcp.mesh.example.com"
                );
            });
        });

        describe('handling undefined apiHost', () => {
            it('omits API origin completely from connect-src without extra spaces or undefined', () => {
                const csp = contentSecurityPolicy(sampleSite, undefined, "'sha256-test'");

                expect(csp).toContain(
                    "connect-src 'self' https://mcp.mesh.example.com wss://mcp.mesh.example.com"
                );
                expect(csp).not.toContain('undefined');
                expect(csp).not.toMatch(/connect-src 'self'  /);
            });

            it('omits API origin correctly in HTTP mode when apiHost is undefined', () => {
                process.env.PUBLIC_SCHEME = 'http';
                const csp = contentSecurityPolicy(sampleSite, undefined, "'sha256-test'");

                expect(csp).toContain(
                    "connect-src 'self' http://mcp.mesh.example.com ws://mcp.mesh.example.com"
                );
                expect(csp).not.toContain('undefined');
            });
        });
    });
});
