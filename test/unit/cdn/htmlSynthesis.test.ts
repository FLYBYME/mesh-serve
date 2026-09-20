import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { escapeHtml, inlineScript, maintenancePage } from '../../../src/cdn/gateway.js';

describe('CDN HTML synthesis', () => {
    describe('escapeHtml', () => {
        it('escapes ampersand (&)', () => {
            expect(escapeHtml('foo & bar')).toBe('foo &amp; bar');
            expect(escapeHtml('&&&')).toBe('&amp;&amp;&amp;');
        });

        it('escapes less-than (<)', () => {
            expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
            expect(escapeHtml('<<<')).toBe('&lt;&lt;&lt;');
        });

        it('escapes greater-than (>)', () => {
            expect(escapeHtml('>test>')).toBe('&gt;test&gt;');
            expect(escapeHtml('>>>')).toBe('&gt;&gt;&gt;');
        });

        it('escapes double quotes (")', () => {
            expect(escapeHtml('"quoted"')).toBe('&quot;quoted&quot;');
            expect(escapeHtml('"""')).toBe('&quot;&quot;&quot;');
        });

        it('escapes single quotes (\')', () => {
            expect(escapeHtml("'single'")).toBe('&#039;single&#039;');
            expect(escapeHtml("'''")).toBe('&#039;&#039;&#039;');
        });

        it('escapes all special characters in a combined string', () => {
            const input = `& < > " '`;
            const expected = `&amp; &lt; &gt; &quot; &#039;`;
            expect(escapeHtml(input)).toBe(expected);
        });

        it('neutralizes potential HTML injection and XSS vectors', () => {
            const input = `<script>alert("XSS & 'pwned'")</script>`;
            const expected = `&lt;script&gt;alert(&quot;XSS &amp; &#039;pwned&#039;&quot;)&lt;/script&gt;`;
            expect(escapeHtml(input)).toBe(expected);
        });

        it('preserves alphanumeric strings and safe punctuation without alteration', () => {
            const safe = 'Hello-World_123 / path / value: 42; 100%';
            expect(escapeHtml(safe)).toBe(safe);
        });

        it('handles empty string gracefully', () => {
            expect(escapeHtml('')).toBe('');
        });
    });

    describe('inlineScript', () => {
        it('escapes less-than (<) to unicode escape sequence \\u003c', () => {
            const script = `console.log("</script>");`;
            const result = inlineScript(script);

            expect(result.escaped).toBe(`console.log("\\u003c/script>");`);
            expect(result.escaped).not.toContain('<');
        });

        it('escapes multiple less-than occurrences throughout the body', () => {
            const code = `if (a < b && c < d) { return "<tag>"; }`;
            const result = inlineScript(code);

            expect(result.escaped).toBe(`if (a \\u003c b && c \\u003c d) { return "\\u003ctag>"; }`);
            expect(result.escaped).not.toContain('<');
        });

        it('preserves other characters untouched in the escaped output', () => {
            const code = `const msg = "test & 'quote' > 5";`;
            const result = inlineScript(code);

            expect(result.escaped).toBe(code);
        });

        it('computes correct SHA-256 Base64 hash for CSP allowlist over escaped content', () => {
            const script = `import { start } from '@flybyme/mesh-web'; start();`;
            const result = inlineScript(script);

            const expectedHash = `sha256-${crypto.createHash('sha256').update(result.escaped).digest('base64')}`;
            expect(result.hash).toBe(expectedHash);
            expect(result.hash).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
        });

        it('verifies that the hash is computed on the escaped text, not the unescaped text', () => {
            const script = `const closing = "</script>";`;
            const result = inlineScript(script);

            const rawHash = `sha256-${crypto.createHash('sha256').update(script).digest('base64')}`;
            const escapedHash = `sha256-${crypto.createHash('sha256').update(result.escaped).digest('base64')}`;

            expect(result.hash).toBe(escapedHash);
            expect(result.hash).not.toBe(rawHash);
        });

        it('produces deterministic output for identical script bodies', () => {
            const code = `console.log('hello world');`;
            const res1 = inlineScript(code);
            const res2 = inlineScript(code);

            expect(res1.escaped).toBe(res2.escaped);
            expect(res1.hash).toBe(res2.hash);
        });

        it('computes expected hash for empty script body', () => {
            const result = inlineScript('');
            const expectedEmptyHash = `sha256-${crypto.createHash('sha256').update('').digest('base64')}`;

            expect(result.escaped).toBe('');
            expect(result.hash).toBe(expectedEmptyHash);
        });
    });

    describe('maintenancePage generation', () => {
        const sampleSite = {
            host: 'example.com',
            mcpHost: 'mcp.example.com',
            tenantId: 'tenant-123',
            application: 'dashboard',
            policy: {},
            theme: {},
            title: 'Customer Dashboard',
            description: 'Customer Dashboard Portal',
            indexable: true,
            maintenance: true,
        };

        it('generates valid HTML structure with charset, title, and body elements', () => {
            const html = maintenancePage(sampleSite);

            expect(html.startsWith('<!DOCTYPE html><html><head>')).toBe(true);
            expect(html.endsWith('</body></html>')).toBe(true);
            expect(html).toContain('<meta charset="UTF-8">');
            expect(html).toContain('<title>Customer Dashboard -- under maintenance</title>');
            expect(html).toContain('<body><h1>Customer Dashboard</h1>');
            expect(html).toContain('<p>This site is temporarily down for maintenance. Please check back shortly.</p>');
        });

        it('uses site.title when present', () => {
            const html = maintenancePage({
                title: 'My Custom Title',
                application: 'fallback-app',
            });

            expect(html).toContain('<title>My Custom Title -- under maintenance</title>');
            expect(html).toContain('<h1>My Custom Title</h1>');
            expect(html).not.toContain('fallback-app');
        });

        it('falls back to site.application when site.title is empty', () => {
            const html = maintenancePage({
                title: '',
                application: 'portal-app',
            });

            expect(html).toContain('<title>portal-app -- under maintenance</title>');
            expect(html).toContain('<h1>portal-app</h1>');
        });

        it('escapes special characters in site.title to prevent HTML injection', () => {
            const html = maintenancePage({
                title: '<Admin> & "Security" Portal\'s Page',
                application: 'admin',
            });

            const escapedTitle = '&lt;Admin&gt; &amp; &quot;Security&quot; Portal&#039;s Page';
            expect(html).toContain(`<title>${escapedTitle} -- under maintenance</title>`);
            expect(html).toContain(`<h1>${escapedTitle}</h1>`);
            expect(html).not.toContain('<Admin>');
            expect(html).not.toContain('"Security"');
        });

        it('escapes special characters in site.application when falling back', () => {
            const html = maintenancePage({
                title: '',
                application: '<script>alert(1)</script>',
            });

            const escapedApp = '&lt;script&gt;alert(1)&lt;/script&gt;';
            expect(html).toContain(`<title>${escapedApp} -- under maintenance</title>`);
            expect(html).toContain(`<h1>${escapedApp}</h1>`);
            expect(html).not.toContain('<script>alert(1)</script>');
        });

    });
});
