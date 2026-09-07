/**
 * What a release is, and how it gets its name.
 *
 * Pure, and deliberately: two nodes composing the same set must land on the same hash without
 * talking to each other, which is only true if the hash depends on nothing but its inputs.
 */

import { canonical, digestOf } from '../../builder/methods/content.js';
import { parse, satisfies } from '../../catalog/methods/semver.js';
import type { PinnedArtifact } from '../schema/release.js';

export interface Composition {
    readonly kernel: PinnedArtifact;
    readonly parts: Readonly<Record<string, PinnedArtifact>>;
    readonly policy: Readonly<Record<string, string>>;
}

/**
 * The identity of a release.
 *
 * **Over the digests, not the versions.** A version is a name somebody chose; a digest is the bytes.
 * Hashing versions would make two releases equal while serving different code, which is exactly the
 * thing a release exists to rule out — and it would survive the one case that matters, a version
 * republished from a different commit.
 *
 * Versions go in anyway, because `1.4.2` and `1.4.2-hotfix` resolving to identical bytes is a real
 * situation and telling them apart in a rollback list is worth the extra field.
 *
 * `tenantId`, `name` and `composedAt` are **not** inputs. Two organizations composing the same
 * kernel and parts have composed the same thing, and a hash that disagreed would store the same
 * artifacts twice under two names.
 */
export function releaseHash(composition: Composition): string {
    const parts = Object.entries(composition.parts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, pinned]) => [id, pinned.version, pinned.digest]);

    return digestOf(canonical({
        kernel: [composition.kernel.version, composition.kernel.digest],
        parts,
        policy: composition.policy,
    }));
}

// ---------------------------------------------------------------------------- checking one

export interface Requirement {
    /** The part that wants it. Named in the refusal, because "something needs auth" is unactionable. */
    readonly by: string;
    readonly id: string;
    readonly version: string;
    readonly optional: boolean;
}

export interface CompositionProblem {
    readonly kind: 'missing_part' | 'missing_optional' | 'unmet_contract' | 'unused_grant' | 'kernel_mismatch';
    readonly message: string;
}

export interface KernelCheck {
    readonly version: string;
    /** Declared kernel ranges by part name. Absent or undefined means no kernel requirement. */
    readonly ranges?: Readonly<Record<string, string | undefined>>;
}

/**
 * Does this set of parts actually hold together?
 *
 * Four checks, and the difference between them is the point:
 *
 * **A required part that is absent → refuse.** An Application consuming `AUTH` on a page with no auth
 * Extension is a blank panel and a console error. Finding out at compose time is the difference
 * between a refused deploy and a broken site.
 *
 * **An optional part that is absent → report.** That is a part working as designed with a feature
 * switched off, and refusing it would make `optional` meaningless.
 *
 * **A contract required with no grant → refuse.** A part calling something the site does not expose
 * is a 404 nobody can distinguish from a route that never existed.
 *
 * A grant with nothing requiring it is reported, never refused: that is the route somebody left
 * behind when they deleted the screen that used it, and it is worth seeing without being fatal.
 *
 * **A kernel range that is not satisfied → refuse.** A part built against `^0.6` served on a kernel
 * at `0.11` or `0.13` breaks in the browser. Stating the incompatibility at compose time is the
 * whole reason `partVersion.kernel` is stored. An absent range is not a mismatch: a kernel artifact
 * has no kernel requirement, and parts published before the field existed are accepted.
 */
export function checkComposition(
    present: readonly string[],
    required: readonly Requirement[],
    requiredContracts: readonly string[],
    grantedContracts: readonly string[],
    kernel?: KernelCheck,
): readonly CompositionProblem[] {
    const problems: CompositionProblem[] = [];
    const have = new Set(present);

    for (const need of required) {
        if (have.has(need.id)) continue;

        problems.push(need.optional
            ? {
                kind: 'missing_optional',
                message: `${need.by} can use "${need.id}" (${need.version}) and this release has none.`,
            }
            : {
                kind: 'missing_part',
                message: `${need.by} requires "${need.id}" (${need.version}) and this release has none.`,
            });
    }

    const granted = new Set(grantedContracts);
    for (const key of requiredContracts) {
        if (granted.has(key)) continue;
        problems.push({
            kind: 'unmet_contract',
            message: `This release calls "${key}" and the site does not expose it.`,
        });
    }

    const wanted = new Set(requiredContracts);
    for (const key of grantedContracts) {
        if (wanted.has(key)) continue;
        problems.push({
            kind: 'unused_grant',
            message: `The site exposes "${key}" and nothing in this release calls it.`,
        });
    }

    if (kernel !== undefined && kernel.version !== '' && kernel.ranges !== undefined) {
        const kernelSemver = parse(kernel.version) !== undefined ? kernel.version : `${kernel.version}.0`;
        for (const [part, range] of Object.entries(kernel.ranges)) {
            if (range === undefined || range === '') continue;
            if (!satisfies(kernelSemver, range)) {
                problems.push({
                    kind: 'kernel_mismatch',
                    message: `${part} requires kernel ${range}, but this release serves ${kernel.version}.`,
                });
            }
        }
    }

    return problems;
}

/** Whether a set of problems should stop a compose. Reports are not failures. */
export const isFatal = (problem: CompositionProblem): boolean =>
    problem.kind === 'missing_part' || problem.kind === 'unmet_contract' || problem.kind === 'kernel_mismatch';
