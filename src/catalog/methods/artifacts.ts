import path from 'node:path';
import os from 'node:os';

import { MeshError } from '@flybyme/mesh';

export const artifactDir = path.join(os.homedir(), '.mesh', 'artifacts');

// Test seam only, same pattern as corePartPlacement.ts's resetCorePartPlacementIndex: every real
// node has exactly one real ~/.mesh/artifacts (one process, one $HOME), so this map is always empty
// in production and artifactAssetPath falls through to the real constant unconditionally. It exists
// because two in-process test nodes otherwise share that one real path -- with no way to make
// "present on node A, absent on node B" a genuine filesystem fact rather than a same-process
// coincidence -- and a handler always has its own ctx.nodeID to key this by.
const testArtifactDirs = new Map<string, string>();
export function setTestArtifactDir(nodeID: string, dir: string): void {
    testArtifactDirs.set(nodeID, dir);
}
export function clearTestArtifactDirs(): void {
    testArtifactDirs.clear();
}

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
 * artifact's own directory (e.g. via "../" segments in the request path). `nodeID`, when given, is
 * only ever consulted against `testArtifactDirs` above -- real callers pass `ctx.nodeID` and get
 * the real `artifactDir` back exactly as before.
 */
export function artifactAssetPath(artifactHash: string, assetPath: string, nodeID?: string): string {
    const dir = (nodeID !== undefined ? testArtifactDirs.get(nodeID) : undefined) ?? artifactDir;
    const base = path.resolve(dir, artifactHash) + path.sep;
    const resolved = path.resolve(base, assetPath);
    if (!resolved.startsWith(base)) {
        throw new MeshError({ message: `Asset path "${assetPath}" escapes its artifact directory.`, code: 'BAD_REQUEST', status: 400 });
    }
    return resolved;
}
