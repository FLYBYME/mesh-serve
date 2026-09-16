import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MeshError } from '@flybyme/mesh';
import { contentTypeFor, artifactAssetPath, artifactDir } from '../../../src/catalog/methods/artifacts.js';

describe('catalog artifact utilities', () => {
    describe('contentTypeFor', () => {
        it('returns correct MIME types for standard web script and style assets', () => {
            expect(contentTypeFor('app.js')).toBe('text/javascript; charset=utf-8');
            expect(contentTypeFor('module.mjs')).toBe('text/javascript; charset=utf-8');
            expect(contentTypeFor('styles.css')).toBe('text/css; charset=utf-8');
            expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8');
        });

        it('returns correct MIME types for data, vector, and binary formats', () => {
            expect(contentTypeFor('data.json')).toBe('application/json; charset=utf-8');
            expect(contentTypeFor('icon.svg')).toBe('image/svg+xml');
            expect(contentTypeFor('module.wasm')).toBe('application/wasm');
            expect(contentTypeFor('font.woff2')).toBe('font/woff2');
        });

        it('returns correct MIME types for other supported assets', () => {
            expect(contentTypeFor('image.png')).toBe('image/png');
            expect(contentTypeFor('photo.jpg')).toBe('image/jpeg');
            expect(contentTypeFor('photo.jpeg')).toBe('image/jpeg');
            expect(contentTypeFor('anim.gif')).toBe('image/gif');
            expect(contentTypeFor('photo.webp')).toBe('image/webp');
            expect(contentTypeFor('favicon.ico')).toBe('image/x-icon');
            expect(contentTypeFor('font.woff')).toBe('font/woff');
            expect(contentTypeFor('notes.txt')).toBe('text/plain; charset=utf-8');
            expect(contentTypeFor('app.js.map')).toBe('application/json; charset=utf-8');
        });

        it('handles file extensions case-insensitively', () => {
            expect(contentTypeFor('ENTRY.JS')).toBe('text/javascript; charset=utf-8');
            expect(contentTypeFor('MODULE.MJS')).toBe('text/javascript; charset=utf-8');
            expect(contentTypeFor('STYLE.CSS')).toBe('text/css; charset=utf-8');
            expect(contentTypeFor('INDEX.HTML')).toBe('text/html; charset=utf-8');
            expect(contentTypeFor('DATA.JSON')).toBe('application/json; charset=utf-8');
            expect(contentTypeFor('LOGO.SVG')).toBe('image/svg+xml');
            expect(contentTypeFor('CORE.WASM')).toBe('application/wasm');
            expect(contentTypeFor('FONT.WOFF2')).toBe('font/woff2');
        });

        it('resolves extensions from nested paths correctly', () => {
            expect(contentTypeFor('dist/chunks/entry.js')).toBe('text/javascript; charset=utf-8');
            expect(contentTypeFor('/assets/sub/nested/style.css')).toBe('text/css; charset=utf-8');
        });

        it('falls back to application/octet-stream for unknown extensions or extensionless paths', () => {
            expect(contentTypeFor('archive.unknown')).toBe('application/octet-stream');
            expect(contentTypeFor('data.bin')).toBe('application/octet-stream');
            expect(contentTypeFor('binary.xyz')).toBe('application/octet-stream');
            expect(contentTypeFor('README')).toBe('application/octet-stream');
            expect(contentTypeFor('')).toBe('application/octet-stream');
            expect(contentTypeFor('.gitignore')).toBe('application/octet-stream');
        });
    });

    describe('artifactAssetPath', () => {
        const hash = 'a1b2c3d4e5f67890abcdef1234567890abcdef12';

        it('resolves standard asset path to absolute filesystem path within artifact directory', () => {
            const expected = path.resolve(artifactDir, hash, 'entry.js');
            const resolved = artifactAssetPath(hash, 'entry.js');

            expect(resolved).toBe(expected);
            expect(resolved.startsWith(path.resolve(artifactDir, hash) + path.sep)).toBe(true);
        });

        it('resolves nested subdirectories within the artifact directory', () => {
            const expected = path.resolve(artifactDir, hash, 'sub', 'nested', 'chunk.js');
            const resolved = artifactAssetPath(hash, 'sub/nested/chunk.js');

            expect(resolved).toBe(expected);
            expect(resolved.startsWith(path.resolve(artifactDir, hash) + path.sep)).toBe(true);
        });

        it('resolves safe relative path segments that stay inside the artifact directory', () => {
            const expected = path.resolve(artifactDir, hash, 'entry.js');
            const resolved = artifactAssetPath(hash, 'sub/../entry.js');

            expect(resolved).toBe(expected);
        });

        it('prevents path traversal escaping via parent directory segments (../outside)', () => {
            expect(() => artifactAssetPath(hash, '../outside')).toThrow(MeshError);

            try {
                artifactAssetPath(hash, '../outside');
                expect.unreachable('Should have thrown MeshError');
            } catch (err) {
                expect(err).toBeInstanceOf(MeshError);
                const meshErr = err as MeshError;
                expect(meshErr.status).toBe(400);
                expect(meshErr.code).toBe('BAD_REQUEST');
                expect(meshErr.message).toBe('Asset path "../outside" escapes its artifact directory.');
            }
        });

        it('prevents deep path traversal attempts', () => {
            expect(() => artifactAssetPath(hash, '../../etc/passwd')).toThrow(MeshError);
            expect(() => artifactAssetPath(hash, 'sub/../../outside.js')).toThrow(MeshError);
            expect(() => artifactAssetPath(hash, 'a/b/../../../secret.txt')).toThrow(MeshError);
        });

        it('prevents absolute path attempts escaping the artifact directory', () => {
            expect(() => artifactAssetPath(hash, '/etc/passwd')).toThrow(MeshError);
            expect(() => artifactAssetPath(hash, '/var/log')).toThrow(MeshError);
        });

        it('rejects directory itself or parent directory references', () => {
            expect(() => artifactAssetPath(hash, '.')).toThrow(MeshError);
            expect(() => artifactAssetPath(hash, '..')).toThrow(MeshError);
        });
    });
});
