import {
    createClient,
    fetchTransport,
    withHeaders,
    MeshCallError,
} from '@flybyme/mesh-web/net';
import { apiSurfdnsNetApi } from './api.js';

async function main() {
    const origin = process.env.API_URL ?? 'https://api.surfdns.net';
    let token: string | undefined;

    // 1. Initialize client with dynamic Authorization header
    const client = createClient(apiSurfdnsNetApi, {
        transport: withHeaders(
            fetchTransport(origin),
            (): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {}),
        ),
        checkExposure: false,
    });

    const email = process.env.DEMO_EMAIL ?? 'admin@surfdns.net';
    const password = process.env.DEMO_PASSWORD ?? 'password1234567';

    // 2. Log in: exchange email + password for a bearer ticket
    console.log(`Logging in as ${email}...`);
    const ticket = await client.call('identity.ticket.issue', {
        email,
        password,
    });

    token = ticket.token;
    console.log(`Login successful! User ID: ${ticket.userId}`);

    // 3. Call whoami with the acquired bearer token
    console.log('Calling identity.whoami...');
    const user = await client.call('identity.whoami');
    console.log('User identity:', user);

    console.log('Calling domain.find...');
    const domains = await client.call('domain.find', {
        limit: 1000,
        offset: 0,
    });
    console.log('Domains:', domains);

    console.log('Calling dnsZone.find...');
    const dnsZones = await client.call('dnsZone.find', {
        limit: 1000,
        offset: 0,
    });
    console.log('DNS Zones:', dnsZones);

    console.log('Calling dnsRecord.find...');
    const dnsRecords = await client.call('dnsRecord.find', {
        limit: 1000,
        offset: 0,
    });

    for (const dnsRecord of dnsRecords) {
        if (dnsRecord.type === 'A') {
            console.log(`[A]  ${dnsRecord.name.padEnd(20)} ${dnsRecord.address}`)
        }
        if (dnsRecord.type === 'NS') {
            console.log(`[NS] ${dnsRecord.name.padEnd(20)} ${dnsRecord.target}`)
        }
    }

    console.log('Calling repo.find...');
    const repos = await client.call('repo.find', {
        limit: 1000,
        offset: 0,
    });
    console.log('Repos:', repos);

    console.log('Calling repoAccess.find...');
    const repoAccesses = await client.call('repoAccess.find', {
        limit: 1000,
        offset: 0,
    });
    console.log('Repo Accesses:', repoAccesses);

    console.log('Calling certOrder.find...');
    const certOrders = await client.call('certOrder.find', {
        limit: 1000,
        offset: 0,
    });
    console.log('Cert Orders:', certOrders);
}

main().catch((err) => {
    if (err instanceof MeshCallError) {
        console.error('MeshCallError:', err.message, err.error);
    } else {
        console.error('Error:', err);
    }
    process.exitCode = 1;
});




