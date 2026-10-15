import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { gitAuthEnv } from '../../../src/catalog/methods/build.js';

const run = promisify(execFile);

/**
 * What git itself reads from a configuration given through the environment -- and only that: the
 * machine's own global and system config are left out (a laptop with the same insteadOf rewrites
 * in ~/.gitconfig answered each twice), and so is this checkout's: run outside it (CI's checkout
 * keeps its own GitHub header in .git/config, and answered it too, 10-14).
 */
async function gitConfig(env: Record<string, string>, ...args: string[]): Promise<string> {
    const isolated = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const { stdout } = await run('git', ['config', ...args], { cwd: tmpdir(), env: { ...process.env, ...isolated, ...env } });

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

    it('gives a repo\'s own credential to its host only (serve.repo.credential, resolved for the build)', async () => {
        const repo = { id: 'r1', url: 'https://git.one-host.ca/org/site.git', token: 'repo-token' };
        const env = gitAuthEnv(undefined, repo);

        const header = await gitConfig(env, '--get', 'http.https://git.one-host.ca/.extraheader');
        expect(header).toBe(`AUTHORIZATION: basic ${Buffer.from('x-access-token:repo-token').toString('base64')}`);
        expect(Object.values(env).some((v) => v.includes('repo-token'))).toBe(false);
        expect(await gitConfig(env, '--get', 'http.https://github.com/.extraheader').catch(() => 'none')).toBe('none');
    });

    it('sends one Authorization to GitHub when the repo there has its own credential', async () => {
        const repo = { id: 'r1', url: 'https://github.com/org/private.git', token: 'repo-token' };
        const env = gitAuthEnv('builder-token', repo);

        const headers = (await gitConfig(env, '--get-all', 'http.https://github.com/.extraheader')).split('\n');
        expect(headers).toEqual([`AUTHORIZATION: basic ${Buffer.from('x-access-token:repo-token').toString('base64')}`]);
    });

    it('never puts the token in plain text anywhere git could print it (a URL, a config value)', () => {
        const env = gitAuthEnv('test-token');

        expect(Object.values(env).some((v) => v.includes('test-token'))).toBe(false);
    });
});
