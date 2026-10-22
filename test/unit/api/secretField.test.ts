import { describe, expect, it } from 'vitest';

import { isSecretName, secretFieldOf } from '../../../src/api/methods/secretField.js';

describe('secretField', () => {
    it('identifies secret field names case-insensitively', () => {
        expect(isSecretName('secret')).toBe(true);
        expect(isSecretName('password')).toBe(true);
        expect(isSecretName('passphrase')).toBe(true);
        expect(isSecretName('token')).toBe(true);
        expect(isSecretName('apiKey')).toBe(true);
        expect(isSecretName('APIKEY')).toBe(true);
        expect(isSecretName('privateKey')).toBe(true);
        expect(isSecretName('clientSecret')).toBe(true);
        expect(isSecretName('credential')).toBe(true);
        expect(isSecretName('credentials')).toBe(true);

        expect(isSecretName('name')).toBe(false);
        expect(isSecretName('id')).toBe(false);
        expect(isSecretName('host')).toBe(false);
    });

    it('finds secret fields with non-empty string values', () => {
        expect(secretFieldOf({ name: 'test', password: 'plain' })).toBe('password');
        expect(secretFieldOf({ token: '' })).toBeUndefined();
        expect(secretFieldOf({ token: 123 })).toBeUndefined();
        expect(secretFieldOf({ name: 'plain' })).toBeUndefined();
    });
});
