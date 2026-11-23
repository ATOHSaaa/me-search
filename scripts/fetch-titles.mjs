import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import sites from '../src/data/sites.json' with { type: 'json' };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sitesPath = path.join(root, 'src/data/sites.json');

const only = new Set(process.argv.slice(2));
const selected = only.size ? sites.filter((site) => only.has(site.shot)) : sites;

async function readMetaTitle(page) {
	await page.waitForFunction(
		() => {
			const raw =
				document.querySelector('title')?.textContent?.replace(/\s+/g, ' ').trim() ||
				document.title.replace(/\s+/g, ' ').trim();
			return raw.length > 0;
		},
		null,
		{ timeout: 20_000 },
	);

	return page.evaluate(() => {
		const fromTag = document.querySelector('title')?.textContent?.replace(/\s+/g, ' ').trim();
		if (fromTag) return fromTag;
		return document.title.replace(/\s+/g, ' ').trim();
	});
}

async function prepPage(page, readyMs) {
	await page.evaluate(async () => {
		if (document.fonts?.ready) await document.fonts.ready;
	});
	await page.keyboard.press('Escape');
	await page.evaluate(() => {
		for (const el of document.querySelectorAll('button, [role="button"]')) {
			const raw = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`
				.replace(/\s+/g, ' ')
				.trim();
			if (raw === 'いいえ' || raw.toLowerCase() === 'no') {
				el.click();
				return;
			}
		}
	});

	const hasCanvas = await page.evaluate(() => document.querySelector('canvas') !== null);
	const paintMs = readyMs ?? (hasCanvas ? 4800 : 1200);
	await page.waitForTimeout(paintMs);
}

const browser = await chromium.launch({
	channel: 'chrome',
	headless: true,
	args: ['--hide-scrollbars', '--enable-webgl', '--use-gl=angle', '--ignore-gpu-blocklist'],
});

const contextOptions = {
	viewport: { width: 1280, height: 720 },
	deviceScaleFactor: 1,
	colorScheme: 'light',
	locale: 'ja-JP',
	userAgent:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

const titleUpdates = new Map();
const failed = [];

for (const site of selected) {
	const context = await browser.newContext(contextOptions);
	const page = await context.newPage();
	try {
		await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
		await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
		const readyMs = typeof site.readyMs === 'number' ? site.readyMs : undefined;
		await prepPage(page, readyMs);
		const title = await readMetaTitle(page);
		if (title) titleUpdates.set(site.shot, title);
		console.log(site.shot, title || '(empty)');
	} catch (error) {
		failed.push(site.shot);
		console.error('fail', site.shot, error instanceof Error ? error.message : error);
	} finally {
		await context.close();
	}
}

await browser.close();

if (titleUpdates.size > 0) {
	const allSites = JSON.parse(await readFile(sitesPath, 'utf8'));
	const next = allSites.map((entry) => {
		const title = titleUpdates.get(entry.shot);
		if (!title) return entry;
		return { ...entry, title };
	});
	await writeFile(sitesPath, `${JSON.stringify(next, null, 2)}\n`);
}

if (failed.length) process.exitCode = 1;