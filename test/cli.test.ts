/**
 * The CLI's pure parts.
 *
 * The command loop itself is verified end to end against a running node; these are the pieces that
 * break silently — argument parsing and the path filling that decides what a flag becomes.
 */

import { describe, expect, it } from 'vitest';

import { parseArgv } from '../src/cli/run.js';

describe('parsing arguments', () => {
    it('reads a command, its words, and its flags', () => {
        const parsed = parseArgv(['organization', 'create', '--name', 'platform']);
        expect(parsed).toMatchObject({
            command: 'organization',
            rest: ['create'],
            flags: { name: 'platform' },
        });
    });

    /** `--yes` and `--json` take no value, and a flag followed by another flag is one of those. */
    it('treats a valueless flag as true', () => {
        expect(parseArgv(['site', 'find', '--json']).flags).toEqual({ json: true });
        expect(parseArgv(['x', '--yes', '--host', 'a']).flags).toEqual({ yes: true, host: 'a' });
    });

    it('defaults to help with no arguments', () => {
        expect(parseArgv([]).command).toBe('help');
    });

    /**
     * A value that looks like a flag is still a value when it was introduced by one. This is where
     * `--name --weird` would otherwise silently become two flags and a missing name.
     */
    it('does not swallow the next flag as a value', () => {
        const parsed = parseArgv(['x', '--a', '--b', 'two']);
        expect(parsed.flags).toEqual({ a: true, b: 'two' });
    });
});
