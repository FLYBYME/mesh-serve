#!/usr/bin/env -S npx tsx
/// <reference lib="dom" />
/**
 * Fills and submits the console's sign-in form for real, in a real Chrome, and reports whether it
 * actually signed in -- not just that the form is present. Complements checkPage.ts, which only
 * confirms a page loads cleanly; this exercises the one interaction a static screenshot can't prove.
 *
 * Usage: npx tsx test/puppeteer/signIn.ts <url> <email> <password>
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

async function main(): Promise<void> {
    const [url, email, password] = process.argv.slice(2);
    if (url === undefined || email === undefined || password === undefined) {
        throw new Error('Usage: signIn.ts <url> <email> <password>');
    }

    const executablePath = await findChrome();
    const browser = await puppeteer.launch({ executablePath, headless: true });
    try {
        const page = await browser.newPage();

        const consoleMessages: string[] = [];
        const pageErrors: string[] = [];
        page.on('console', (msg) => { if (msg.type() === 'error') consoleMessages.push(msg.text()); });
        page.on('pageerror', (err) => { pageErrors.push(err instanceof Error ? err.message : String(err)); });

        await page.goto(url, { waitUntil: 'networkidle0', timeout: 15000 });

        // The sign-in form's inputs are named "email"/"password" (signIn.ts's own Field name arg).
        await page.waitForSelector('input[name="email"]', { timeout: 5000 });
        await page.type('input[name="email"]', email);
        await page.type('input[name="password"]', password);

        const submitted = await page.evaluate(() => {
            const button = document.querySelector<HTMLButtonElement>('.ui-sign-in-submit');
            if (button === null) return false;
            button.click();
            return true;
        });
        if (!submitted) throw new Error('Could not find the sign-in submit button (.ui-sign-in-submit).');

        // signIn() is async (a real network round trip); give it real time rather than a fixed sleep
        // racing the response.
        await page.waitForFunction(
            () => document.querySelector('.ui-sign-in-done') !== null
                || document.querySelector('.ui-sign-in-error') !== null,
            { timeout: 10000 },
        );

        const signedInText = await page.evaluate(
            () => document.querySelector('.ui-sign-in-done')?.textContent ?? null,
        );
        const errorText = await page.evaluate(
            () => document.querySelector('.ui-sign-in-error-text')?.textContent ?? null,
        );

        const screenshotPath = path.join(import.meta.dirname, 'screenshots', `signIn-${Date.now()}.png`);
        await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
        await page.screenshot({ path: screenshotPath as `${string}.png`, fullPage: true });

        console.log(`Signed in:        ${signedInText ?? 'no'}`);
        console.log(`Form error:       ${errorText ?? 'none'}`);
        console.log(`Console errors:   ${consoleMessages.length}`);
        for (const m of consoleMessages) console.log(`  ${m}`);
        console.log(`Page errors:      ${pageErrors.length}`);
        for (const e of pageErrors) console.log(`  ${e}`);
        console.log(`Screenshot:       ${screenshotPath}`);

        process.exitCode = signedInText !== null && pageErrors.length === 0 ? 0 : 1;
    } finally {
        await browser.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
