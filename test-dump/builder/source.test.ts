/**
 * Fetching a source, and the credential that reaches a private one.
 *
 * The tests worth having are about **where a token must not end up**. A token that works is obvious
 * within seconds; a token written into a build log is discovered much later, in a database, by
 * somebody who was looking for something else.
 */

import { describe, expect, it } from 'vitest';

import { credentialsFromEnv } from '../../src/builder/methods/source.js';

describe('credentials from the environment', () => {
    it('finds a token for the host it is named after', () => {
        const held = credentialsFromEnv({ GIT_TOKEN_GITHUB_COM: 'ghp_secret' });
        expect(held('github.com')).toBe('ghp_secret');
    });

    it('lets one node hold credentials for more than one forge', () => {
        const held = credentialsFromEnv({
            GIT_TOKEN_GITHUB_COM: 'gh', GIT_TOKEN_GIT_EXAMPLE_COM: 'other',
        });
        expect(held('github.com')).toBe('gh');
        expect(held('git.example.com')).toBe('other');
    });

    it('falls back to a single token for a node that talks to one', () => {
        const held = credentialsFromEnv({ GIT_TOKEN: 'only' });
        expect(held('anywhere.example')).toBe('only');
    });

    it('has nothing for a public repository, which needs nothing', () => {
        expect(credentialsFromEnv({})('github.com')).toBeUndefined();
    });

    it('treats an empty variable as absent', () => {
        // An unset variable and one set to '' both mean "no credential". Sending `Basic
        // eC1hY2Nlc3MtdG9rZW46` would be an authentication attempt with an empty password, which
        // fails differently and more confusingly than not authenticating at all.
        expect(credentialsFromEnv({ GIT_TOKEN: '   ' })('github.com')).toBeUndefined();
    });

    it('prefers the host-specific token over the fallback', () => {
        const held = credentialsFromEnv({ GIT_TOKEN: 'general', GIT_TOKEN_GITHUB_COM: 'specific' });
        expect(held('github.com')).toBe('specific');
    });
});
