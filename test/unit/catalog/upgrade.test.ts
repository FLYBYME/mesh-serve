import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The node's side of serve.node.upgrade reads and writes under ~/.mesh/upgrade: pointed at a temp
// home before the module computes its paths.
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'upgrade-test-'));
process.env['HOME'] = home;
const { hostAgentInstalled, readUpgradeResult, runningVersion, UPGRADE_DIR, writeUpgradeRequest } = await import('../../../src/catalog/methods/upgrade.js');

describe('the node side of serve.node.upgrade', () => {
    beforeAll(async () => { await fs.mkdir(UPGRADE_DIR, { recursive: true }); });
    afterAll(async () => { await fs.rm(home, { recursive: true, force: true }); });

    it('knows its own release', () => {
        expect(runningVersion()).toMatch(/^v\d+\.\d+\.\d+$/);
    });

    it('writes only a release version -- anything else never reaches the host', async () => {
        await writeUpgradeRequest('v0.8.17');
        expect(await fs.readFile(path.join(UPGRADE_DIR, 'request'), 'utf8')).toBe('v0.8.17\n');
        await expect(writeUpgradeRequest('v0.8.1; rm -rf /')).rejects.toThrow(/Not a release version/);
        await expect(writeUpgradeRequest('ghcr.io/evil/x:v1.0.0')).rejects.toThrow(/Not a release version/);
    });

    it('reads what the host did, and ignores anything it cannot trust', async () => {
        expect(await readUpgradeResult()).toBeUndefined();
        await fs.writeFile(path.join(UPGRADE_DIR, 'result.json'), JSON.stringify({ requested: 'v0.8.17', from: 'v0.8.16', status: 'done', message: 'v0.8.16 -> v0.8.17', at: '2026-09-26T20:00:00Z' }));
        expect(await readUpgradeResult()).toEqual({ requested: 'v0.8.17', from: 'v0.8.16', status: 'done', message: 'v0.8.16 -> v0.8.17', at: '2026-09-26T20:00:00Z' });
        await fs.writeFile(path.join(UPGRADE_DIR, 'result.json'), JSON.stringify({ status: 'pwned' }));
        expect(await readUpgradeResult()).toBeUndefined();
        await fs.writeFile(path.join(UPGRADE_DIR, 'result.json'), 'not json');
        expect(await readUpgradeResult()).toBeUndefined();
    });

    it('says whether its host can upgrade it', async () => {
        expect(await hostAgentInstalled()).toBe(false);
        await fs.writeFile(path.join(UPGRADE_DIR, 'agent-installed'), '');
        expect(await hostAgentInstalled()).toBe(true);
    });
});
