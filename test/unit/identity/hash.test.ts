import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword, issuedToken, hashToken } from '../../../src/identity/methods/hash.js';

describe('hash utilities', () => {
    describe('hashPassword & verifyPassword', () => {
        it('hashes a password and verifies it successfully', async () => {
            const password = 'SuperSecretPassword123!';
            const hash = await hashPassword(password);

            expect(hash).toContain(':');
            const [saltHex, derivedHex] = hash.split(':');
            expect(saltHex).toHaveLength(32); // 16 bytes = 32 hex chars
            expect(derivedHex).toHaveLength(128); // 64 bytes = 128 hex chars

            const isValid = await verifyPassword(password, hash);
            expect(isValid).toBe(true);
        });

        it('rejects an incorrect password', async () => {
            const hash = await hashPassword('CorrectPassword');
            const isValid = await verifyPassword('WrongPassword', hash);
            expect(isValid).toBe(false);
        });

        it('generates unique salts across multiple hashes of identical passwords', async () => {
            const password = 'CommonPassword';
            const hash1 = await hashPassword(password);
            const hash2 = await hashPassword(password);

            expect(hash1).not.toBe(hash2);
            expect(await verifyPassword(password, hash1)).toBe(true);
            expect(await verifyPassword(password, hash2)).toBe(true);
        });

        it('handles malformed stored hash strings gracefully without throwing', async () => {
            expect(await verifyPassword('test', '')).toBe(false);
            expect(await verifyPassword('test', 'no-colon')).toBe(false);
            expect(await verifyPassword('test', 'invalidHex:notHex')).toBe(false);
            expect(await verifyPassword('test', ':')).toBe(false);
        });
    });

    describe('issuedToken', () => {
        it('generates a 64-character hex string (32 bytes entropy)', () => {
            const token1 = issuedToken();
            const token2 = issuedToken();

            expect(token1).toHaveLength(64);
            expect(token1).toMatch(/^[0-9a-f]{64}$/);
            expect(token2).toHaveLength(64);
            expect(token1).not.toBe(token2);
        });
    });

    describe('hashToken', () => {
        it('computes deterministic SHA-256 hex digest of a token', () => {
            const token = 'abcdef123456';
            const hash1 = hashToken(token);
            const hash2 = hashToken(token);

            expect(hash1).toHaveLength(64);
            expect(hash1).toBe(hash2);
            expect(hashToken('different-token')).not.toBe(hash1);
        });
    });
});
