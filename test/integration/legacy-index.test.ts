import { MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const MONGO = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
let reachable = false;
try {
    const testClient = new MongoClient(MONGO, { serverSelectionTimeoutMS: 500 });
    await testClient.connect();
    await testClient.db('admin').command({ ping: 1 });
    await testClient.close();
    reachable = true;
} catch (e) {
    reachable = false;
}

describe.runIf(reachable)('Legacy index refusal', () => {
    it('refuses to start when email_1 index exists and prints instructions', async () => {
        const dbName = `mesh-serve-test-legacy-index-${Date.now()}`;
        const client = new MongoClient(MONGO);
        await client.connect();
        const db = client.db(dbName);
        
        // Create the legacy index
        await db.collection('user').createIndex({ email: 1 }, { unique: true, name: 'email_1' });
        await client.close();

        const { stdout, stderr } = await execAsync(
            `node bin/mesh-serve.mjs node --db ${dbName}`
        ).catch((e) => e);

        expect(stderr).toContain('Startup failed: A legacy index exists that conflicts with the current schema.');
        expect(stderr).toContain(`Database:   ${dbName}`);
        expect(stderr).toContain('Collection: user');
        expect(stderr).toContain('Index:      email_1');
        expect(stderr).toContain(`use ${dbName}`);
        expect(stderr).toContain('db.user.dropIndex("email_1")');

        const cleanupClient = new MongoClient(MONGO);
        await cleanupClient.connect();
        await cleanupClient.db(dbName).dropDatabase();
        await cleanupClient.close();
    });
});
