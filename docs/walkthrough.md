# End-to-End Operational Walkthrough

This guide walks through configuring, building, composing, and deploying an application from scratch on `@flybyme/mesh-serve`. It is derived directly from the real implementation in [`src/examples/composeConsole.ts`](file:///home/ubuntu/code/mesh-serve/src/examples/composeConsole.ts) and [`test/bootstrap.integration.test.ts`](file:///home/ubuntu/code/mesh-serve/test/bootstrap.integration.test.ts).

---

## Prerequisites & Starting the Node

Start the node with local development ports and schemes enabled:

```bash
# Terminal 1: Start mesh-serve node
mesh-serve start \
  --publicScheme http \
  --publicApiPort 5005 \
  --apiPort 5005 \
  --cdnPort 3123
```

On first boot, [`IdentityService`](file:///home/ubuntu/code/mesh-serve/src/identity/identity.service.ts#L37) creates the `platform` organization and outputs a temporary claim token to the console:
```text
[INFO] FIRST BOOT: provisional operator account created.
[INFO] Claim operator with: mesh-serve login --claim <one-time-claim-token>
```

---

## Step 1: Claim the Operator Account & Sign In

In another terminal, claim the provisional account:

```bash
mesh-serve login --claim <one-time-claim-token>
```

Set a permanent password:
```bash
mesh-serve identity user.setPassword --password "MySecretPassword123!"
```

Verify your identity and organization membership:
```bash
mesh-serve identity whoami
```
Output:
```json
{
  "userId": "usr_...",
  "email": "operator@node.invalid",
  "displayName": "Operator",
  "roles": ["operator"],
  "organizations": [
    { "organizationId": "org_platform_id", "name": "Platform", "roleKey": "owner" }
  ]
}
```

---

## Step 2: Register Repositories and Parts

Register the source control repository where code resides:

```bash
mesh-serve serve.repo create \
  --tenantId "org_platform_id" \
  --url "https://github.com/my-org/my-web-app.git" \
  --defaultBranch "master"
```

Create a **kernel** part (the core `@flybyme/mesh-web` runtime):
```bash
mesh-serve serve.part create \
  --tenantId "org_platform_id" \
  --repoId "<repo-id>" \
  --key "platform/kernel" \
  --kind "kernel" \
  --path "." \
  --entryPoint "src/kernel.ts"
```

Create an **application** part (the web application UI):
```bash
mesh-serve serve.part create \
  --tenantId "org_platform_id" \
  --repoId "<repo-id>" \
  --key "platform/blog" \
  --kind "application" \
  --path "apps/blog" \
  --entryPoint "src/index.ts"
```

---

## Step 3: Trigger Builds & Wait for Artifacts

Queue compilation for both parts:

```bash
# Build the kernel
mesh-serve serve.artifact requestBuild \
  --partId "<kernel-part-id>" \
  --ref "HEAD"

# Build the application
mesh-serve serve.artifact requestBuild \
  --partId "<blog-part-id>" \
  --ref "HEAD"
```

The [`CatalogService`](file:///home/ubuntu/code/mesh-serve/src/catalog/catalog.service.ts#L17) background worker will pick up the pending artifacts, run `esbuild`, extract contract dependencies from `mesh.wants.json`, and store the compiled output in `~/.mesh/artifacts/<hash>/`.

Check artifact status:
```bash
mesh-serve serve.artifact find --query '{"status": "success"}'
```

---

## Step 4: Assemble a Composition & Compose a Release

Create a composition combining the kernel and application:

```bash
mesh-serve serve.composition create \
  --tenantId "org_platform_id" \
  --key "platform/blog" \
  --kernelPartKey "platform/kernel" \
  --parts '["platform/blog"]'
```

Generate an immutable release snapshot via [`serve.composition.compose`](file:///home/ubuntu/code/mesh-serve/src/catalog/tools/compose.ts#L62):

```bash
mesh-serve serve.composition compose --id "<composition-id>"
```

Output:
```json
{
  "id": "rel_...",
  "tenantId": "org_platform_id",
  "compositionId": "comp_...",
  "hash": "a4b8c9d1e2f3...",
  "parts": [
    { "partKey": "platform/kernel", "kind": "kernel", "artifactHash": "7f8a9b..." },
    { "partKey": "platform/blog", "kind": "application", "artifactHash": "3c4d5e..." }
  ]
}
```

---

## Step 5: Configure the Site & Deploy the Release

Resolve the platform's bootstrap API ID:
```bash
mesh-serve serve.api find_one --query '{"apiHost": "api.localhost"}'
```

Create a new frontend site bound to `blog.localhost`:
```bash
mesh-serve serve.cdn create \
  --host "blog.localhost" \
  --apiId "<api-id>" \
  --mcpHost "blog-mcp.localhost" \
  --tenantId "org_platform_id" \
  --application "platform/blog" \
  --policy '{"mode": "desktop"}' \
  --theme '{"--primary-color": "#2563eb"}' \
  --title "My Platform Blog" \
  --description "A blog running on mesh-serve" \
  --indexable true
```

Deploy the release hash to the site:
```bash
mesh-serve serve.cdn deploy \
  --siteId "<site-id>" \
  --releaseHash "a4b8c9d1e2f3..."
```

[`serve.cdn.deploy`](file:///home/ubuntu/code/mesh-serve/src/cdn/tools/deploy.ts#L17) validates compatibility, sets `site.releaseHash`, and reconciles all required contract dependencies into `serve.want`.

---

## Step 6: Expose Backend APIs for the Application

Inspect the contracts required by the site's deployed code:
```bash
mesh-serve serve.want find --query '{"siteId": "<site-id>"}'
```

Expose the required contracts on the API gateway:
```bash
# Expose user inspection publicly
mesh-serve serve.expose add \
  --apiId "<api-id>" \
  --contract "identity.whoami"

# Expose admin contract gated by operator role
mesh-serve serve.expose add \
  --apiId "<api-id>" \
  --contract "serve.site.find" \
  --role "operator"
```

---

## Step 7: Generate Typed TypeScript/Zod Client

Generate a self-contained API client reflecting the live exposed contracts:

```bash
mesh-serve serve.api generateClient --apiId "<api-id>"
```
Or write directly to file using the CLI:
```bash
mesh-serve generate --out ./src/generated-api-client.ts
```

The emitted client provides type-safe methods using Zod schemas derived directly from `@flybyme/mesh` contracts:
```ts
import { myApi } from './generated-api-client';

const identity = await myApi['identity.whoami']();
console.log(identity.email);
```

---

## Step 8: Open in Browser

Configure your local hosts file (`/etc/hosts`) if needed:
```text
127.0.0.1 blog.localhost api.localhost
```

Navigate to `http://blog.localhost:3123`:
1. [`CdnService`](file:///home/ubuntu/code/mesh-serve/src/cdn/cdn.service.ts#L95) resolves the host `blog.localhost`.
2. Generates the HTML envelope with strict CSP hashes.
3. The browser downloads the kernel and blog bundles from `/assets/<hash>/entry.js`.
4. The application boots and communicates with `http://api.localhost:5005/api/`.
