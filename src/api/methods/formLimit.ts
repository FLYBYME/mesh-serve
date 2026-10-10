/**
 * Public forms, limited per client address. A form that mails someone -- sign-up (its verification
 * link), a password reset, the contact form -- already limits mail per email address; a bot that
 * changes the address each time was not slowed at all (10-06: a contact message, a registration with
 * a stranger's address, a reset, in 30 s). Per address, per hour, in memory on each api node.
 */
export const FORM_LIMITS: Readonly<Record<string, number>> = {
    'identity.user.register': 5,
    'identity.user.reset_request': 10,
    'email.contact': 10,
};

const WINDOW_MS = 3600_000;

/**
 * A person reads a form before sending it; a bot posts it the moment it has the page, or without
 * ever loading it (10-08: a contact message, a sign-up and a reset within 30 s). The page says how
 * long the form was on screen (`shownForMs`, measured by the page itself, so no clock is compared);
 * a public form sent without it, or within this, is refused. Only these forms, only through the api.
 */
export const FORM_MIN_SHOWN_MS = 3000;

/**
 * Whether a form with no measure at all is refused. Off for one release: the site can only send
 * `shownForMs` once the live api describes it (its client is generated from the api). A form
 * without it is still allowed and said (`unmeasured`) until the site sends it; then this is on.
 */
export const FORM_MEASURE_REQUIRED = false;

/**
 * Whether this call is one of the public forms sent too fast. Returns the input without
 * `shownForMs` -- the service is never handed the page's own measure (an older build of it would not
 * know the field).
 */
export function formTiming(
    contract: string,
    input: Readonly<Record<string, unknown>>,
    required: boolean = FORM_MEASURE_REQUIRED,
): { tooFast: boolean; unmeasured: boolean; input: Record<string, unknown> } {
    const { shownForMs, ...rest } = input;
    if (FORM_LIMITS[contract] === undefined) return { tooFast: false, unmeasured: false, input: { ...input } };

    if (shownForMs === undefined) return { tooFast: required, unmeasured: true, input: rest };

    const tooFast = typeof shownForMs !== 'number' || !Number.isFinite(shownForMs) || shownForMs < FORM_MIN_SHOWN_MS;

    return { tooFast, unmeasured: false, input: rest };
}

export class FormLimiter {
    private readonly hits = new Map<string, number[]>();

    constructor(
        private readonly limits: Readonly<Record<string, number>> = FORM_LIMITS,
        private readonly now: () => number = Date.now,
        private readonly maxKeys = 50_000,
    ) {}

    /** Whether this address may call this contract now; counts the call when it may. Others always may. */
    allow(contract: string, clientIp: string): boolean {
        const limit = this.limits[contract];
        if (limit === undefined) return true;

        const key = `${contract}\u0000${clientIp}`;
        const since = this.now() - WINDOW_MS;
        const recent = (this.hits.get(key) ?? []).filter((t) => t > since);
        if (recent.length >= limit) {
            this.hits.set(key, recent);
            return false;
        }

        recent.push(this.now());
        this.hits.delete(key);
        this.hits.set(key, recent);
        while (this.hits.size > this.maxKeys) {
            const oldest = this.hits.keys().next().value;
            if (oldest === undefined) break;
            this.hits.delete(oldest);
        }
        return true;
    }
}

/**
 * The client's address: the api answers only through our own proxy (its port is on the fleet,
 * firewalled), which replaces X-Forwarded-For with the address it saw (surfdns-proxy
 * `wire/router.ts`). The last entry, so a proxy that appended instead would still be read right.
 */
export function clientAddress(forwardedFor: string | string[] | undefined, socketAddress: string | undefined): string {
    const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
    const last = header?.split(',').map((s) => s.trim()).filter((s) => s !== '').pop();

    return last ?? socketAddress ?? 'unknown';
}
