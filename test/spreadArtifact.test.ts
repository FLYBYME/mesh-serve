import { describe, expect, it } from 'vitest';

import { copyTargets } from '../src/catalog/methods/spreadArtifact.js';

describe('copyTargets: which nodes are asked to keep a copy of a build', () => {
    it('asks the artifacts=keep nodes first, then any other, never one that holds it', () => {
        expect(copyTargets(['edge1', 'ns1', 'ns2', 'surf'], ['surf', 'ns2'], ['edge1'])).toEqual(['ns2', 'surf', 'ns1']);
    });

    it('skips a keeper that is not available', () => {
        expect(copyTargets(['edge1', 'ns1'], ['surf'], ['edge1'])).toEqual(['ns1']);
    });

    it('has no one to ask when the builder is the only node', () => {
        expect(copyTargets(['edge1'], [], ['edge1'])).toEqual([]);
    });
});
