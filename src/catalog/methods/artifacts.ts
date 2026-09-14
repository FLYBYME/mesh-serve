import path from 'node:path';
import os from 'node:os';

import { MeshError } from '@flybyme/mesh';

export const artifactDir = path.join(os.homedir(), '.mesh', 'artifacts');

const contentTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
};

export function contentTypeFor(assetPath: string): string {
    return contentTypes[path.extname(assetPath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Resolves an artifact-relative asset path to an absolute filesystem path, refusing to escape the
 * artifact's own directory (e.g. via "../" segments in the request path).
 */
export function artifactAssetPath(artifactHash: string, assetPath: string): string {
    const base = path.resolve(artifactDir, artifactHash) + path.sep;
    const resolved = path.resolve(base, assetPath);
    if (!resolved.startsWith(base)) {
        throw new MeshError({ message: `Asset path "${assetPath}" escapes its artifact directory.`, code: 'BAD_REQUEST', status: 400 });
    }
    return resolved;
}
