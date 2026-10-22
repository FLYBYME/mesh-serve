/**
 * The name of a call's input field that carries a secret, if one does -- pure. A held call is kept
 * as it came, to replay it, so a call carrying one is never held (gateway.ts). Read by the field's
 * name at the top of the input, the names this platform's calls use for a plaintext secret.
 */
const SECRET_NAMES = /^(secret|password|passphrase|token|apiKey|privateKey|clientSecret|credentials?)$/i;

export function secretFieldOf(input: Readonly<Record<string, unknown>>): string | undefined {
    return Object.keys(input).find((key) => SECRET_NAMES.test(key) && typeof input[key] === 'string' && input[key] !== '');
}
