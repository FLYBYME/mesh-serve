export interface DescribedCall {
    readonly key: string;
    readonly domain: string;
    readonly action: string;
    readonly description: string;
    readonly method: string;
    readonly path: string;
    readonly gate: string;
    readonly input?: unknown;
    readonly output?: unknown;
    readonly destructive?: boolean;
    readonly stream?: boolean;
}

export interface ExposureDescriptor {
    readonly host: string;
    readonly base: string;
    readonly exposure: string;
    readonly shapeHash: string;
    readonly calls: readonly DescribedCall[];
}

function baseUrl(apiHost: string): string {
    return apiHost.startsWith('http://') || apiHost.startsWith('https://') ? apiHost : `http://${apiHost}`;
}

export async function fetchDescriptor(apiHost: string): Promise<ExposureDescriptor> {
    let res: Response;
    try {
        res = await fetch(`${baseUrl(apiHost)}/api/_describe`);
    } catch (cause) {
        throw new Error(`Could not reach an api server at "${apiHost}" -- is one running there?`, { cause });
    }
    if (!res.ok) {
        throw new Error(`Failed to fetch descriptor from "${apiHost}": ${res.status} ${res.statusText}`);
    }
    return await res.json() as ExposureDescriptor;
}

export { baseUrl };
