import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT_PATH = path.resolve(__dirname, '../../deploy/provision.sh');

describe('deploy/provision.sh', () => {
    let tempDir: string;
    let targetDir: string;
    let sourceRepoDir: string;
    let envFile: string;
    let systemdDir: string;
    let mockBinDir: string;
    let mockSystemctl: string;
    let mockJournalctl: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-provision-test-'));
        sourceRepoDir = path.join(tempDir, 'source-repo');
        targetDir = path.join(tempDir, 'srv-mesh-serve');
        envFile = path.join(tempDir, 'etc-mesh', 'node.env');
        systemdDir = path.join(tempDir, 'etc-systemd');
        mockBinDir = path.join(tempDir, 'bin');

        fs.mkdirSync(mockBinDir, { recursive: true });

        mockSystemctl = path.join(mockBinDir, 'systemctl');
        fs.writeFileSync(
            mockSystemctl,
            '#!/bin/sh\nif [ "$1" = "is-active" ]; then echo "active"; exit 0; fi\nexit 0\n',
            { mode: 0o755 },
        );

        mockJournalctl = path.join(mockBinDir, 'journalctl');
        fs.writeFileSync(
            mockJournalctl,
            '#!/bin/sh\necho "mesh-serve is up"\nexit 0\n',
            { mode: 0o755 },
        );

        // Setup source git repository with deploy/mesh-node.service
        fs.mkdirSync(path.join(sourceRepoDir, 'deploy'), { recursive: true });
        fs.writeFileSync(
            path.join(sourceRepoDir, 'deploy', 'mesh-node.service'),
            fs.readFileSync(path.resolve(__dirname, '../../deploy/mesh-node.service')),
        );
        execFileSync('git', ['init', '-b', 'master', sourceRepoDir]);
        execFileSync('git', ['-C', sourceRepoDir, 'config', 'user.email', 'test@example.com']);
        execFileSync('git', ['-C', sourceRepoDir, 'config', 'user.name', 'Tester']);
        execFileSync('git', ['-C', sourceRepoDir, 'add', '.']);
        execFileSync('git', ['-C', sourceRepoDir, 'commit', '-m', 'initial']);
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const runScript = (args: string[], options: {
        stdin?: string;
        env?: Record<string, string>;
    } = {}) => {
        return spawnSync(SCRIPT_PATH, args, {
            input: options.stdin,
            env: {
                ...process.env,
                PATH: `${mockBinDir}:${process.env.PATH}`,
                MESH_TARGET_DIR: targetDir,
                MESH_ENV_FILE: envFile,
                MESH_SYSTEMD_DIR: systemdDir,
                MESH_REPO_URL: sourceRepoDir,
                MESH_SYSTEMCTL_BIN: mockSystemctl,
                MESH_JOURNALCTL_BIN: mockJournalctl,
                MESH_SKIP_ROOT_CHECK: '1',
                MESH_SKIP_BUILD: '1',
                ...options.env,
            },
            encoding: 'utf8',
        });
    };

    it('prints help when invoked with --help', () => {
        const res = runScript(['--help']);
        expect(res.status).toBe(0);
        expect(res.stdout).toContain('Usage: cat node.env |');
        expect(res.stdout).toContain('--dry-run');
        expect(res.stdout).toContain('--head');
        expect(res.stdout).toContain('--dial-in');
    });

    it('fails when no env file exists and no stdin is provided', () => {
        const res = runScript(['--dry-run'], { stdin: '' });
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('does not exist and no environment configuration was piped via stdin');
    });

    it('writes piped environment to env file with mode 0600 and dir with 0700', () => {
        const envContent = 'MONGODB_URI=mongodb://localhost:27017\nMESH_KEY=testkey123\n';
        const res = runScript(['--dial-in'], {
            stdin: envContent,
        });

        if (res.status !== 0) {
            console.error('STDOUT:', res.stdout);
            console.error('STDERR:', res.stderr);
        }
        expect(res.status).toBe(0);
        expect(fs.existsSync(envFile)).toBe(true);
        expect(fs.readFileSync(envFile, 'utf8')).toBe(envContent);

        const envStat = fs.statSync(envFile);
        expect((envStat.mode & 0o777)).toBe(0o600);

        const dirStat = fs.statSync(path.dirname(envFile));
        expect((dirStat.mode & 0o777)).toBe(0o700);
    });

    it('converges on re-run: preserves existing envFile when stdin is empty', () => {
        fs.mkdirSync(path.dirname(envFile), { recursive: true, mode: 0o700 });
        fs.writeFileSync(envFile, 'EXISTING=true\n', { mode: 0o600 });

        const res = runScript([], {
            stdin: '',
        });

        if (res.status !== 0) {
            console.error('STDOUT:', res.stdout);
            console.error('STDERR:', res.stderr);
        }
        expect(res.status).toBe(0);
        expect(fs.readFileSync(envFile, 'utf8')).toBe('EXISTING=true\n');
        expect((fs.statSync(envFile).mode & 0o777)).toBe(0o600);
    });

    it('confines mesh port to 127.0.0.1 on dial-in nodes via drop-in override', () => {
        fs.mkdirSync(path.dirname(envFile), { recursive: true });
        fs.writeFileSync(envFile, 'SOME_VAR=1\n', { mode: 0o600 });

        const res = runScript(['--dial-in']);

        expect(res.status).toBe(0);

        const overridePath = path.join(systemdDir, 'mesh-node.service.d', 'override.conf');
        expect(fs.existsSync(overridePath)).toBe(true);

        const overrideContent = fs.readFileSync(overridePath, 'utf8');
        expect(overrideContent).toContain('--ws-host 127.0.0.1');
        expect(overrideContent).not.toContain('--ws-host 0.0.0.0');
    });

    it('keeps 0.0.0.0 binding and no override on head node', () => {
        fs.mkdirSync(path.dirname(envFile), { recursive: true });
        fs.writeFileSync(envFile, 'SOME_VAR=1\n', { mode: 0o600 });

        // First simulate dial-in having created an override
        const overrideDir = path.join(systemdDir, 'mesh-node.service.d');
        fs.mkdirSync(overrideDir, { recursive: true });
        fs.writeFileSync(path.join(overrideDir, 'override.conf'), 'stale override');

        const res = runScript(['--head']);

        expect(res.status).toBe(0);

        const overridePath = path.join(systemdDir, 'mesh-node.service.d', 'override.conf');
        expect(fs.existsSync(overridePath)).toBe(false);

        const baseUnit = fs.readFileSync(path.join(systemdDir, 'mesh-node.service'), 'utf8');
        expect(baseUnit).toContain('--ws-host 0.0.0.0');
    });

    it('fails verification if node process enters failed state', () => {
        const failSystemctl = path.join(mockBinDir, 'systemctl-fail');
        fs.writeFileSync(
            failSystemctl,
            '#!/bin/sh\nif [ "$1" = "is-active" ]; then echo "failed"; exit 1; fi\nexit 0\n',
            { mode: 0o755 },
        );

        fs.mkdirSync(path.dirname(envFile), { recursive: true });
        fs.writeFileSync(envFile, 'VAR=1\n', { mode: 0o600 });

        const res = runScript(['--verify-only'], {
            env: {
                MESH_SYSTEMCTL_BIN: failSystemctl,
            },
        });

        expect(res.status).toBe(1);
        expect(res.stderr).toContain("mesh-node entered 'failed' state");
    });

    it('fails verification when service times out without becoming ready', () => {
        const inactiveSystemctl = path.join(mockBinDir, 'systemctl-inactive');
        fs.writeFileSync(
            inactiveSystemctl,
            '#!/bin/sh\nif [ "$1" = "is-active" ]; then echo "activating"; exit 3; fi\nexit 0\n',
            { mode: 0o755 },
        );

        fs.mkdirSync(path.dirname(envFile), { recursive: true });
        fs.writeFileSync(envFile, 'VAR=1\n', { mode: 0o600 });

        const res = runScript(['--verify-only'], {
            env: {
                MESH_SYSTEMCTL_BIN: inactiveSystemctl,
                MESH_VERIFY_TIMEOUT: '1',
            },
        });

        expect(res.status).toBe(1);
        expect(res.stderr).toContain('did not become ready within 1s');
    });

    it('checks out a pinned tag or commit ref cleanly', () => {
        // Create a commit and a tag in source repo
        fs.writeFileSync(path.join(sourceRepoDir, 'version.txt'), 'v1.0.0-content');
        execFileSync('git', ['-C', sourceRepoDir, 'add', '.']);
        execFileSync('git', ['-C', sourceRepoDir, 'commit', '-m', 'version 1.0.0']);
        execFileSync('git', ['-C', sourceRepoDir, 'tag', 'v1.0.0']);
        const tagCommit = execFileSync('git', ['-C', sourceRepoDir, 'rev-parse', 'v1.0.0'], { encoding: 'utf8' }).trim();

        // Create another commit after the tag
        fs.writeFileSync(path.join(sourceRepoDir, 'version.txt'), 'v1.1.0-content');
        execFileSync('git', ['-C', sourceRepoDir, 'add', '.']);
        execFileSync('git', ['-C', sourceRepoDir, 'commit', '-m', 'version 1.1.0']);

        fs.mkdirSync(path.dirname(envFile), { recursive: true });
        fs.writeFileSync(envFile, 'SOME_VAR=1\n', { mode: 0o600 });

        // Run provision targeting tag v1.0.0
        const res = runScript(['v1.0.0']);
        expect(res.status).toBe(0);

        const checkedOutCommit = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        expect(checkedOutCommit).toBe(tagCommit);
        expect(fs.readFileSync(path.join(targetDir, 'version.txt'), 'utf8')).toBe('v1.0.0-content');

        // Now run provision targeting the commit hash
        const headCommit = execFileSync('git', ['-C', sourceRepoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        const res2 = runScript([headCommit]);
        expect(res2.status).toBe(0);

        const checkedOutCommit2 = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        expect(checkedOutCommit2).toBe(headCommit);
        expect(fs.readFileSync(path.join(targetDir, 'version.txt'), 'utf8')).toBe('v1.1.0-content');
    });

    it('refuses to run as non-root when MESH_SKIP_ROOT_CHECK=0', () => {
        if (process.getuid && process.getuid() === 0) {
            return; // Skip if already running as root
        }

        fs.mkdirSync(path.dirname(envFile), { recursive: true });
        fs.writeFileSync(envFile, 'VAR=1\n', { mode: 0o600 });

        const res = runScript([], {
            env: {
                MESH_SKIP_ROOT_CHECK: '0',
            },
        });

        expect(res.status).toBe(1);
        expect(res.stderr).toContain('must be run as root');
    });
});
