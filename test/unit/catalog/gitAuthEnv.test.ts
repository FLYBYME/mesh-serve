import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { gitAuthEnv } from '../../../src/catalog/methods/build.js';

const run = promisify(execFile);

/** What git itself reads from a configuration given through the environment. */
async function gitConfig(env: Record<string, string>, ...args: string[]): Promise<string> {
    const { stdout } = await run('git', ['config', ...args], { env: { ...process.env, ...env } });

    return stdout.trim();
}

describe('the builder\'s GitHub access (gitAuthEnv)', () => {
    it('adds nothing without a token: public repositories still build', () => {
        expect(gitAuthEnv(undefined)).toEqual({});
        expect(gitAuthEnv('  ')).toEqual({});
    });

    it('gives git the token as a header, and turns ssh GitHub URLs (npm lockfiles) into https', async () => {
        const env = gitAuthEnv('test-token');

        const header = await gitConfig(env, '--get', 'http.https://github.com/.extraheader');
        expect(header).toBe(`AUTHORIZATION: basic ${Buffer.from('x-access-token:test-token').toString('base64')}`);

        const rewrites = (await gitConfig(env, '--get-all', 'url.https://github.com/.insteadOf')).split('\n');
        expect(rewrites).toEqual(['ssh://git@github.com/', 'git@github.com:']);

        expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    });

    it('never puts the token in plain text anywhere git could print it (a URL, a config value)', () => {
        const env = gitAuthEnv('test-token');

        expect(Object.values(env).some((v) => v.includes('test-token'))).toBe(false);
    });
});
