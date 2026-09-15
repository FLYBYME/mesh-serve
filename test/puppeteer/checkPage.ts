#!/usr/bin/env -S npx tsx
/// <reference lib="dom" />
/**
 * Loads one URL in a real Chrome (via puppeteer-core against the system browser -- no bundled
 * Chromium download) and reports what actually happened: console messages, page errors, failed
 * requests, and whether the page rendered anything. Built because Claude-in-Chrome wasn't
 * connected in the session that needed to verify `console.localhost` after the boot-module fix --
 * this is the substitute for "reload it and tell me what's in the console."
 *
 * `*.localhost` hostnames resolve straight to loopback in Chrome with no `/etc/hosts` entry, so a
 * virtual-hosted local server usually just needs the real hostname in the URL
 * (`http://console.localhost:17656`), not a Host-header override -- `--host` exists for the case
 * that isn't (testing by bare IP:port against a server that only recognizes real hostnames).
 *
 * Usage: npx tsx test/puppeteer/checkPage.ts <url> [--host <Host header override>]
 * Example: npx tsx test/puppeteer/checkPage.ts http://console.localhost:17656
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME_CANDIDATES = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
];

async function findChrome(): Promise<string> {
    for (const candidate of CHROME_CANDIDATES) {
        try {
            await fs.access(candidate);
            return candidate;
        } catch {
            // try the next one
        }
    }
    throw new Error(`No Chrome/Chromium binary found in: ${CHROME_CANDIDATES.join(', ')}`);
}

interface Args {
    url: string;
    host: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
    const [url, ...rest] = argv;
    if (url === undefined) {
        throw new Error('Usage: checkPage.ts <url> [--host <Host header>]');
    }
    const hostIndex = rest.indexOf('--host');
    const host = hostIndex === -1 ? undefined : rest[hostIndex + 1];
    return { url, host };
}

async function main(): Promise<void> {
    const { url, host } = parseArgs(process.argv.slice(2));
    const executablePath = await findChrome();

    const browser = await puppeteer.launch({ executablePath, headless: true });
    try {
        const page = await browser.newPage();

        if (host !== undefined) {
            // Virtual-hosted local servers (console.localhost etc.) need the real Host header --
            // navigating to the bare IP:port would hit the site the server picks for an unmatched host.
            await page.setExtraHTTPHeaders({ host });
        }

        const consoleMessages: { type: string; text: string }[] = [];
        const pageErrors: string[] = [];
        const failedRequests: { url: string; reason: string }[] = [];

        page.on('console', (msg) => {
            consoleMessages.push({ type: msg.type(), text: msg.text() });
        });
        page.on('pageerror', (err) => {
            pageErrors.push(err instanceof Error ? err.message : String(err));
        });
        page.on('requestfailed', (req) => {
            failedRequests.push({ url: req.url(), reason: req.failure()?.errorText ?? 'unknown' });
        });

        const response = await page.goto(url, { waitUntil: 'networkidle0', timeout: 15000 });

        // Give any async boot work (start()'s Application.start()) a moment past networkidle.
        await new Promise((resolve) => { setTimeout(resolve, 500); });

        const bodyText = await page.evaluate(() => document.body.innerText);
        const bodyHtmlLength = await page.evaluate(() => document.body.innerHTML.length);
        const title = await page.title();

        const screenshotPath = path.join(
            import.meta.dirname, 'screenshots', `${new URL(url).hostname}-${Date.now()}.png`,
        );
        await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
        await page.screenshot({ path: screenshotPath as `${string}.png`, fullPage: true });

        console.log(`URL:              ${url}${host ? ` (Host: ${host})` : ''}`);
        console.log(`HTTP status:      ${response?.status() ?? 'no response'}`);
        console.log(`Title:            ${title}`);
        console.log(`Body text length: ${bodyText.length}`);
        console.log(`Body HTML length: ${bodyHtmlLength}`);
        console.log(`Screenshot:       ${screenshotPath}`);
        console.log();

        console.log(`Console messages (${consoleMessages.length}):`);
        for (const m of consoleMessages) console.log(`  [${m.type}] ${m.text}`);

        console.log();
        console.log(`Page errors (${pageErrors.length}):`);
        for (const e of pageErrors) console.log(`  ${e}`);

        console.log();
        console.log(`Failed requests (${failedRequests.length}):`);
        for (const f of failedRequests) console.log(`  ${f.url} -- ${f.reason}`);

        const hasProblems = pageErrors.length > 0
            || failedRequests.length > 0
            || consoleMessages.some((m) => m.type === 'error');
        process.exitCode = hasProblems ? 1 : 0;
    } finally {
        await browser.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
