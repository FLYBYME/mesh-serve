/**
 * Passwords, hashed.
 *
 * `scrypt`, from node's own crypto — no dependency, and a memory-hard function rather than a fast
 * one, because the threat is an offline attack on a stolen table and speed is the attacker's
 * advantage.
 *
 * Passkeys are the direction (mesh-web spec/auth.md §4) and this exists because a deployment has to
 * be able to start without one. A user record's `passwordHash` is optional for exactly that reason.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
    password: string, salt: string, keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const SALT_BYTES = 16;

/** `scrypt$<salt hex>$<key hex>`. The scheme is in the string so it can change without a migration. */
export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES).toString('hex');
    const key = await scryptAsync(password, salt, KEY_LENGTH);
    return `scrypt$${salt}$${key.toString('hex')}`;
}

/**
 * Check a password against a stored hash.
 *
 * `timingSafeEqual`, because a comparison that returns early leaks how much of the key matched. And
 * a malformed or unknown-scheme hash answers **false** rather than throwing — a corrupt row must
 * refuse a sign-in, not crash the module that everything else authenticates through.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const [scheme, salt, expected] = stored.split('$');
    if (scheme !== 'scrypt' || salt === undefined || expected === undefined) return false;

    let actual: Buffer;
    try {
        actual = await scryptAsync(password, salt, KEY_LENGTH);
    } catch {
        return false;
    }

    const expectedBuffer = Buffer.from(expected, 'hex');
    if (expectedBuffer.length !== actual.length) return false;

    return timingSafeEqual(actual, expectedBuffer);
}

/**
 * A hash that matches nothing, for the account-does-not-exist case.
 *
 * Verifying against this takes the same work as verifying a real one, so a missing account and a
 * wrong password take the same time. Skipping the work is a timing oracle for which emails have
 * accounts — surfdns got this right and it is carried forward.
 */
export const DUMMY_HASH = `scrypt$${'0'.repeat(SALT_BYTES * 2)}$${'0'.repeat(KEY_LENGTH * 2)}`;
