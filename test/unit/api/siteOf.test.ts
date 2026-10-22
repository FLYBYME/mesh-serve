import { describe, expect, it } from 'vitest';
import { siteOf } from '../../../src/api/gateway.js';

describe('siteOf: which of the api\'s own sites a call came from', () => {
    const sites = ['console.example.com', 'example.com'];

    it('is the page\'s origin when it is one of the api\'s sites, over https', () => {
        expect(siteOf('https://console.example.com', sites)).toBe('https://console.example.com');
        expect(siteOf('https://example.com', sites)).toBe('https://example.com');
    });

    it('is nothing for any other origin: a forged Origin never gets a reset link sent to its host', () => {
        expect(siteOf('https://evil.example.net', sites)).toBeUndefined();
        expect(siteOf('https://console.example.com.evil.net', sites)).toBeUndefined();
        expect(siteOf('http://console.example.com', sites)).toBeUndefined();
        expect(siteOf('https://console.example.com:8443', sites)).toBeUndefined();
        expect(siteOf('null', sites)).toBeUndefined();
        expect(siteOf(undefined, sites)).toBeUndefined();
    });
});
