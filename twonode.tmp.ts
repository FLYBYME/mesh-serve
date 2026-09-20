/**
 * Two real nodes. Node A gets claimed (the bootstrap sequence, run directly). Node B is never
 * told anything -- it should acquire what it needs on demand.
 */
import { BrokerModule, DatabaseModule, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule, PlacementRegistry, RegistryModule } from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';
import type { IServiceBroker } from '@flybyme/mesh';
import './src/catalog/contracts/corePart.contract.js';
import './src/identity/contracts/user.contract.js';
import './src/identity/contracts/organization.contract.js';
import './src/identity/contracts/membership.contract.js';
import './src/identity/contracts/role.contract.js';
import './src/identity/contracts/ticket.contract.js';
import './src/identity/contracts/identity.contract.js';
import './src/api/contracts/api.contract.js';
import './src/api/contracts/expose.contract.js';
import { hashPassword } from './src/identity/methods/hash.js';
import { ensureBootstrapApi } from './src/api/ensureBootstrapApi.js';

const app = new MeshApp({ nodeID: 'two-node-client', logger: new Logger(LogLevel.ERROR) });
app.use(new RegistryModule({ implementation: PlacementRegistry }));
app.use(new NetworkModule({ transports: [new WSTransport(new JSONSerializer(), 6803, '127.0.0.1')], bootstrapNodes: ['ws://127.0.0.1:6801'] }));
app.use(new DatabaseModule({ dbName: 'mesh-two-node' }));
app.use(new BrokerModule());
await app.start();
const broker = app.getProvider<IServiceBroker>('broker');
await new Promise((r) => setTimeout(r, 2000));

const registry = app.getProvider<{ getNodes: () => { nodeID: string }[] }>('registry');
console.log('PEERS:', registry.getNodes().map((n) => n.nodeID).sort().join(', '));

// --- claim node A, the way bootstrap does ---
for (const name of ['identity', 'api', 'cdn'] as const) {
    try {
        console.log('A LOADED', name, JSON.stringify(await broker.call('serve.corePart.load', { name }, { nodeID: 'node-a' })));
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/already running/i.test(message)) throw err;
        console.log('A LOADED', name, '(already running)');
    }
}
await broker.call('identity.role.ensureBuiltins', {});
const pw = await hashPassword('a-real-operator-pass-12');
const user = await broker.call('identity.user.find_one', { query: { email: 'op@two.invalid' } })
    ?? await broker.call('identity.user.create', { email: 'op@two.invalid', displayName: 'Op', passwordHash: pw, roles: ['operator'], provisional: false });
const org = await broker.call('identity.organization.find_one', { query: { slug: 'platform' } })
    ?? await broker.call('identity.organization.create', { slug: 'platform', name: 'Platform', ownerId: user.id });
const meta = { meta: { user: { id: user.id, tenant_id: '', organizationId: org.id } } };
const existingMember = await broker.call('identity.membership.find_one', { query: { userId: user.id } }, meta);
if (existingMember === undefined) {
    await broker.call('identity.membership.create', { userId: user.id, organizationId: org.id, roleKey: 'owner', joinedAt: new Date() }, meta);
}
await ensureBootstrapApi(broker);
console.log('CLAIMED org', org.slug);

// --- node B was told nothing. Ask it for identity directly. ---
console.log('B whoami-contract before:', await broker.call('identity.role.find', { query: {} }, { nodeID: 'node-b' }).then(() => 'answered').catch((e) => 'ERR ' + String(e.message).slice(0, 60)));

// --- the real proof: HTTP through node B's own api listener ---
const res = await fetch('http://api.localhost:5802/api/identity/ticket', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'op@two.invalid', password: 'a-real-operator-pass-12' }),
}).catch((e) => ({ status: 'refused: ' + e.message, text: async () => '' }) as never);
console.log('B /api/identity/ticket:', res.status);
if (res.status === 200) {
    const ticket = JSON.parse(await res.text()) as { token: string };
    const who = await fetch('http://api.localhost:5802/api/identity/whoami', { headers: { authorization: `Bearer ${ticket.token}` } });
    console.log('B /api/identity/whoami:', who.status, (await who.text()).slice(0, 120));
}

await app.stop();
process.exit(0);
