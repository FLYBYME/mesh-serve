# CDN Service & Frontend Delivery

The [`CdnService`](file:///home/ubuntu/code/mesh-serve/src/cdn/cdn.service.ts#L95) (`serve.cdn`) binds public hostnames to deployments, synthesizes HTML boot envelopes for `@flybyme/mesh-web`, enforces Content Security Policies, and streams content-addressed static assets.

---

## Domain Model & Schemas

### [`Site`](file:///home/ubuntu/code/mesh-serve/src/cdn/contracts/site.contract.js) (`serve.site`)
A configured frontend deployment bound to a domain:
* `host`: The frontend hostname (e.g. `console.localhost`, `app.example.com`).
* `apiId`: Optional reference to the backing [`Api`](file:///home/ubuntu/code/mesh-serve/src/api/contracts/api.contract.js) record.
* `mcpHost`: Hostname for MCP connectivity.
* `tenantId`: Owning organization ID.
* `releaseHash`: The pinned [`Release`](file:///home/ubuntu/code/mesh-serve/src/catalog/contracts/release.contract.js) currently served by this site.
* `application`: Namespace for settings storage, preventing collisions between applications sharing a store.
* `policy`: Frozen configuration passed to `@flybyme/mesh-web`'s `BuildPolicy` (e.g. `{ "window-manager/mode": "tiled" }`).
* `open`: Initial application and view layout to mount on boot.
* `theme`: CSS custom property values injected into `:root { ... }`.
* `title`: Page title (falls back to `application` if empty).
* `description`: Meta description tag content.
* `canonical`: Canonical URL link.
* `image`: `og:image` metadata URL.
* `indexable`: When `false`, emits `<meta name="robots" content="noindex, nofollow">`.
* `maintenance`: When `true`, redirects all inbound traffic to `/.well-known/maintenance`.

---

## Deployment & Wants Reconciliation

Deploying a release to a site is handled by [`deploy.ts`](file:///home/ubuntu/code/mesh-serve/src/cdn/tools/deploy.ts):

1. **Security & Compatibility Checks**:
   * Validates that `release.tenantId === site.tenantId`.
   * Verifies that the release composes the application the site was declared to serve (`composition.key === site.application`).
2. **Contract Requirements Reconciliation**:
   * Iterates through every part in the release and extracts its declared `wants` (contract dependencies).
   * Reads existing `serve.want` records for the site.
   * Creates new `serve.want` records for newly introduced contract dependencies (`wantsAdded`).
   * Deletes obsolete `serve.want` records no longer required by the new release (`wantsRemoved`).
3. **Site Update**:
   * Sets `site.releaseHash = release.hash`.

---

## HTML Envelope Generation

When a client requests a web page, [`generateHtml`](file:///home/ubuntu/code/mesh-serve/src/cdn/cdn.service.ts#L300) synthesizes a complete HTML document:

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <title>Application Title</title>
    <!-- Preconnect hints for API and MCP endpoints -->
    <link rel="preconnect" href="https://api.localhost:5005">
    <link rel="preconnect" href="https://mcp.localhost">
    <!-- Inline Theme Styles -->
    <style>:root { --brand-color: #0066cc; }</style>
    <!-- Theme & Part CSS links with SRI integrity attributes -->
    <link rel="stylesheet" href="/assets/<hash>/style.css" integrity="sha384-...">
    <!-- Dynamic Import Map -->
    <script type="importmap">{"imports": {"@flybyme/mesh-core/ui": "/assets/<hash>/index.js"}}</script>
  </head>
  <body>
    <!-- Inline Boot Module -->
    <script type="module">
      import { start } from '@flybyme/mesh-web';
      import part_0 from '/assets/<hash>/entry.js';
      start({
        application: "org/app",
        api: "https://api.localhost:5005",
        policy: {...},
        parts: [{ id: "org/app", contribution: part_0 }]
      });
    </script>
  </body>
</html>
```

### The Boot Module
Unlike flat script tags, the boot module explicitly constructs and registers each application part with the kernel runtime by passing their module exports to `start()`.

### Import Maps
Parts declaring an `imports` specifier (e.g. `@flybyme/mesh-core/ui`) are populated in a `<script type="importmap">` mapping bare specifiers to content-addressed asset URLs (`/assets/<hash>/...`).

### Content Security Policy (CSP)
Inline `<script>` elements (the import map and boot script) are secured using SHA-256 content hashes rather than `'unsafe-inline'`:
```ts
const inlineScript = (body: string): { escaped: string; hash: string } => {
    const escaped = body.replace(/</g, '\\u003c');
    return { escaped, hash: `sha256-${crypto.createHash('sha256').update(escaped).digest('base64')}` };
};
```
The resulting policy is set on the response:
```http
Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-...' 'sha256-...'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://api.localhost:5005 https://mcp.localhost wss://mcp.localhost; img-src 'self' data: https:; font-src 'self'
```

---

## Asset Delivery & Streaming

Static files are requested via `/assets/<artifactHash>/<path>` and served by [`serveAssets`](file:///home/ubuntu/code/mesh-serve/src/cdn/cdn.service.ts#L417):

1. **Path Traversal Protection**: [`artifactAssetPath`](file:///home/ubuntu/code/mesh-serve/src/catalog/methods/artifacts.ts#L36) ensures the resolved file resides strictly inside the specified artifact directory.
2. **Method Enforcement**: Rejects non-`GET`/`HEAD` requests with `405 Method Not Allowed`.
3. **HTTP 304 Validation**: Evaluates `ETag` (`If-None-Match`, including weak `W/` tags) and `Last-Modified` (`If-Modified-Since`) **before** opening file streams on disk.
4. **Lifecycle & Stream Backpressure**: Uses Node's `pipeline(createReadStream(filePath), res)` to stream content directly to the socket, ensuring automatic cleanup if a client disconnects prematurely (`ERR_STREAM_PREMATURE_CLOSE`).
5. **Caching**: Sets `Cache-Control: public, max-age=31536000, immutable` and `X-Content-Type-Options: nosniff`.
