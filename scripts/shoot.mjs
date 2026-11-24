import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import sites from '../src/data/sites.json' with { type: 'json' };
import {
	captureMotionFrames,
	detectScrollPlan,
	writeScrollGif,
} from './lib/scrollGif.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src/assets/shots');
const sitesPath = path.join(root, 'src/data/sites.json');

const PREVIEW_LAYOUT = {
	height: 520,
	desktopWidth: 960,
};

const MOBILE_PREVIEW = {
	width: 390,
	height: 780,
};

const GIF_LAYOUT = {
	desktop: { width: PREVIEW_LAYOUT.desktopWidth, height: PREVIEW_LAYOUT.height },
	mobile: { width: MOBILE_PREVIEW.width, height: MOBILE_PREVIEW.height },
};

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
	channel: 'chrome',
	headless: true,
	args: [
		'--hide-scrollbars',
		'--enable-webgl',
		'--use-gl=angle',
		'--ignore-gpu-blocklist',
	],
});

const only = new Set(process.argv.slice(2));
const selected = only.size ? sites.filter((site) => only.has(site.shot)) : sites;
const failed = [];
const titleUpdates = new Map();

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

async function prepPageFujimaki(page, readyMs) {
	await page.evaluate(async () => {
		if (document.fonts?.ready) await document.fonts.ready;
	});

	await page.locator('canvas[aria-label*="MacBook"]').waitFor({ state: 'visible', timeout: 45_000 });
	const settleMs = typeof readyMs === 'number' ? Math.min(readyMs, 5500) : 4000;
	await page.waitForTimeout(settleMs);

	const start = page.getByRole('button', { name: /press any key/i });
	if (await start.isVisible().catch(() => false)) {
		await page.keyboard.press('Enter');
	}

	await page
		.waitForFunction(
			() => !document.querySelector('button[aria-label="Press any key."]'),
			null,
			{ timeout: 12_000 },
		)
		.catch(() => {});

	await page.waitForTimeout(700);
}

/** 音出し確認（はい／いいえ）が出るまで待ち、この画面で撮影を始める */
async function prepPageIconic(page, readyMs) {
	await page.evaluate(async () => {
		if (document.fonts?.ready) await document.fonts.ready;
	});

	await page.getByText(/音が出ますがよろしいですか/).waitFor({ state: 'visible', timeout: 25_000 });
	await page.getByRole('button', { name: 'はい' }).waitFor({ state: 'visible', timeout: 25_000 });
	await page.getByRole('button', { name: 'いいえ' }).waitFor({ state: 'visible', timeout: 25_000 });

	const paintMs = readyMs ?? 1200;
	await page.waitForTimeout(Math.min(paintMs, 2000));
}

async function prepPage(page, readyMs) {
	await page.evaluate(async () => {
		if (document.fonts?.ready) await document.fonts.ready;
	});
	await page.keyboard.press('Escape');
	await page.evaluate(() => {
		for (const el of document.querySelectorAll('button, [role="button"]')) {
			const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`
				.replace(/\s+/g, ' ')
				.trim()
				.toLowerCase();
			if (label === 'いいえ') {
				el.click();
				return;
			}
		}
		for (const el of document.querySelectorAll('button, [role="button"]')) {
			const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`
				.replace(/\s+/g, ' ')
				.trim()
				.toLowerCase();
			if (label === 'close' || label === '閉じる' || label === 'x' || label === '×') {
				const modal = el.closest('[role="dialog"], [aria-modal="true"]');
				const open = modal
					? getComputedStyle(modal).visibility !== 'hidden' && modal.getAttribute('aria-hidden') !== 'true'
					: el.offsetParent !== null;
				if (!open) continue;
				el.click();
				break;
			}
		}
	});

	const hasCanvas = await page.evaluate(() => document.querySelector('canvas') !== null);
	const paintMs = readyMs ?? (hasCanvas ? 4800 : 800);
	await page.waitForTimeout(paintMs);
	await waitForSplashGone(page).catch(() => {});
}

function splashGonePredicate() {
	for (const el of document.querySelectorAll('.loader, .loading, [class*="splash"]')) {
		const style = getComputedStyle(el);
		if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
		const r = el.getBoundingClientRect();
		if (r.height >= window.innerHeight * 0.45 && r.width >= window.innerWidth * 0.45) {
			return false;
		}
	}
	for (const el of document.querySelectorAll('.overlay, [class*="overlay"]')) {
		const style = getComputedStyle(el);
		if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
		if (el.classList.contains('is-disable-mode')) continue;
		const r = el.getBoundingClientRect();
		if (r.height >= window.innerHeight * 0.45 && r.width >= window.innerWidth * 0.45) {
			return false;
		}
	}
	return true;
}

async function waitForSplashGone(page) {
	await page.waitForFunction(splashGonePredicate, null, { timeout: 35_000 });
}

async function waitForPageReady(page) {
	await waitForSplashGone(page).catch(() => {});
}

async function waitForPreviewPaint(page) {
	const narrow = await page.evaluate(() => window.innerWidth < 500);
	const minBox = narrow ? 72 : 120;
	const minNatural = narrow ? 160 : 240;

	await waitForPageReady(page);

	await page
		.waitForFunction(
			({ minBox, minNatural }) => {
				return [...document.querySelectorAll('img')].some((img) => {
					const r = img.getBoundingClientRect();
					if (r.width < minBox || r.height < minBox) return false;
					if (r.top > window.innerHeight * 0.92) return false;
					return img.complete && img.naturalWidth >= minNatural && img.naturalHeight >= minNatural;
				});
			},
			{ minBox, minNatural },
			{ timeout: 20_000 },
		)
		.catch(() => {});

	await page
		.locator('.swiper-slide-active img, .slick-active img, [aria-hidden="false"] img')
		.first()
		.waitFor({ state: 'visible', timeout: 8000 })
		.catch(() => {});

	await page.evaluate(() => window.scrollTo(0, 0));
	await page.waitForTimeout(400);
}

async function saveWideShot(png, dest) {
	const { desktopWidth, height } = PREVIEW_LAYOUT;
	await sharp(png)
		.resize(desktopWidth, height, { fit: 'cover', position: 'top' })
		.webp({ quality: 76 })
		.toFile(dest);
}

async function saveMobileViewportShot(png, dest) {
	const { width, height } = MOBILE_PREVIEW;
	await sharp(png)
		.resize(width, height, { fit: 'cover', position: 'top' })
		.webp({ quality: 76 })
		.toFile(dest);
}

function motionOptsFromSite(site, viewport) {
	const motion = {};
	const desktop = viewport === 'desktop';
	const frames = desktop ? site.scrollFramesDesktop ?? site.scrollFrames : site.scrollFrames;
	const pxPerFrame = desktop ? site.scrollPxPerFrameDesktop ?? site.scrollPxPerFrame : site.scrollPxPerFrame;
	const gifDelay = desktop ? site.gifDelayMsDesktop ?? site.gifDelayMs : site.gifDelayMs;
	if (typeof frames === 'number') motion.scrollFrames = frames;
	if (typeof pxPerFrame === 'number') motion.scrollPxPerFrame = pxPerFrame;
	if (typeof gifDelay === 'number') motion.gifDelayMs = gifDelay;
	if (site.motionMode === 'keyboard') motion.motionMode = 'keyboard';
	if (Array.isArray(site.motionKeys) && site.motionKeys.length) motion.motionKeys = site.motionKeys;
	if (site.motionMode === 'iconic') motion.motionMode = 'iconic';
	if (site.motionMode === 'morimichi') motion.motionMode = 'morimichi';
	if (site.motionIntro === true) motion.motionIntro = true;
	if (Array.isArray(site.introSampleMs) && site.introSampleMs.length) {
		motion.introSampleMs = site.introSampleMs;
	}
	return motion;
}

async function captureViewportSet(url, contextOptions, readyMs, gifDest, gifSize, shot, motion = {}) {
	const context = await browser.newContext(contextOptions);
	const page = await context.newPage();
	try {
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
		await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

		const useIntroMotion = motion.motionIntro === true;
		let viewportPng;
		let metaTitle = '';

		if (useIntroMotion) {
			await page.evaluate(async () => {
				if (document.fonts?.ready) await document.fonts.ready;
			});
			const plan = await detectScrollPlan(page);
			const motionFrames = await captureMotionFrames(page, url, plan, motion);
			await writeScrollGif(motionFrames, gifDest, { ...gifSize, gifDelayMs: motion.gifDelayMs });
			if (shot === 'iconic') {
				await prepPageIconic(page, readyMs);
			} else if (shot === 'fujimaki') {
				await prepPageFujimaki(page, readyMs);
			} else {
				await prepPage(page, readyMs);
				await waitForPreviewPaint(page);
			}
			metaTitle = await readMetaTitle(page);
			viewportPng = await page.screenshot({ type: 'png' });
		} else {
			const morimichiMotion = motion.motionMode === 'morimichi';
			if (morimichiMotion) {
				await page.evaluate(async () => {
					if (document.fonts?.ready) await document.fonts.ready;
				});
				await page.waitForTimeout(500);
			} else if (shot === 'iconic') {
				await prepPageIconic(page, readyMs);
			} else if (shot === 'fujimaki') {
				await prepPageFujimaki(page, readyMs);
			} else {
				await prepPage(page, readyMs);
				await waitForPreviewPaint(page);
			}
			if (!morimichiMotion) {
				metaTitle = await readMetaTitle(page);
				viewportPng = await page.screenshot({ type: 'png' });
			}
			const plan = await detectScrollPlan(page);
			const motionFrames = await captureMotionFrames(page, url, plan, motion);
			await writeScrollGif(motionFrames, gifDest, { ...gifSize, gifDelayMs: motion.gifDelayMs });
			if (morimichiMotion) {
				await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
				await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
				const gate = page.locator('[data-login-gate]');
				if (await gate.isVisible({ timeout: 8000 }).catch(() => false)) {
					await gate.click({ timeout: 10_000 });
				}
				const settleMs = typeof readyMs === 'number' ? readyMs : 2800;
				await page.waitForTimeout(Math.min(settleMs, 6000));
				await waitForPreviewPaint(page);
				metaTitle = await readMetaTitle(page);
				viewportPng = await page.screenshot({ type: 'png' });
			}
		}

		return { viewportPng, metaTitle };
	} finally {
		await context.close();
	}
}

const desktopContext = {
	viewport: { width: 1280, height: 720 },
	deviceScaleFactor: 1,
	colorScheme: 'light',
	reducedMotion: 'no-preference',
	locale: 'ja-JP',
	userAgent:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

const mobileContext = {
	viewport: { width: 390, height: 844 },
	deviceScaleFactor: 2,
	isMobile: true,
	hasTouch: true,
	colorScheme: 'light',
	reducedMotion: 'no-preference',
	locale: 'ja-JP',
	userAgent:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};

for (const site of selected) {
	const dest = path.join(outDir, `${site.shot}.webp`);
	const gifDest = path.join(outDir, `${site.shot}.gif`);
	const mobileDest = path.join(outDir, `${site.shot}-mobile.webp`);
	const mobileGifDest = path.join(outDir, `${site.shot}-mobile.gif`);
	const darkDest = path.join(outDir, `${site.shot}-dark.webp`);
	const darkGifDest = path.join(outDir, `${site.shot}-dark.gif`);
	const mobileDarkDest = path.join(outDir, `${site.shot}-mobile-dark.webp`);
	const mobileDarkGifDest = path.join(outDir, `${site.shot}-mobile-dark.gif`);
	try {
		const readyMs = typeof site.readyMs === 'number' ? site.readyMs : undefined;
		const wantsDark = site.darkMode === true;
		const motionDesktop = motionOptsFromSite(site, 'desktop');
		const motionMobile = motionOptsFromSite(site, 'mobile');

		const desktop = await captureViewportSet(
			site.url,
			desktopContext,
			readyMs,
			gifDest,
			GIF_LAYOUT.desktop,
			site.shot,
			motionDesktop,
		);
		if (desktop.metaTitle) titleUpdates.set(site.shot, desktop.metaTitle);

		const mobile = await captureViewportSet(
			site.url,
			mobileContext,
			readyMs,
			mobileGifDest,
			GIF_LAYOUT.mobile,
			site.shot,
			motionMobile,
		);

		await saveWideShot(desktop.viewportPng, dest);
		await saveMobileViewportShot(mobile.viewportPng, mobileDest);

		if (wantsDark) {
			const desktopDark = await captureViewportSet(
				site.url,
				{ ...desktopContext, colorScheme: 'dark' },
				readyMs,
				darkGifDest,
				GIF_LAYOUT.desktop,
				site.shot,
				motionDesktop,
			);
			const mobileDark = await captureViewportSet(
				site.url,
				{ ...mobileContext, colorScheme: 'dark' },
				readyMs,
				mobileDarkGifDest,
				GIF_LAYOUT.mobile,
				site.shot,
				motionMobile,
			);
			await saveWideShot(desktopDark.viewportPng, darkDest);
			await saveMobileViewportShot(mobileDark.viewportPng, mobileDarkDest);
		}

		console.log('ok', site.shot, wantsDark ? '+dark' : '');
	} catch (error) {
		failed.push({ shot: site.shot, url: site.url, message: error instanceof Error ? error.message : String(error) });
		console.error('fail', site.shot, error instanceof Error ? error.message : error);
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

if (failed.length) {
	console.error(`\n${failed.length} failed`);
	process.exitCode = 1;
}