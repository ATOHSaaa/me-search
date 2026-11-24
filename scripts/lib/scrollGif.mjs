import { writeFile } from 'node:fs/promises';
import gifenc from 'gifenc';

const { GIFEncoder, applyPalette, quantize } = gifenc;
import sharp from 'sharp';

/** 1フレームあたりの表示時間（全 GIF 共通・ゆっくり） */
const GIF_DELAY_MS = 150;
/** スクロール GIF の最小フレーム数 */
const SCROLL_FRAME_COUNT = 24;
/** この高さ（px）以上はフレーム数を増やしてスクロールをゆっくり見せる */
const SCROLL_PX_PER_FRAME = 280;
const SCROLL_FRAME_MAX = 96;

function scrollFrameCountForExtent(extent, pxPerFrame = SCROLL_PX_PER_FRAME) {
	if (!extent || extent <= 0) return SCROLL_FRAME_COUNT;
	const step = Math.max(120, pxPerFrame);
	return Math.min(SCROLL_FRAME_MAX, Math.max(SCROLL_FRAME_COUNT, Math.ceil(extent / step)));
}
const CLICK_STEPS = 5;
const CLICK_STEP_PAUSE_MS = 1400;
/** ナビボタン押下後、アニメーション途中のキャプチャ（ms・クリック起点） */
const NAV_TRANSITION_MS = [220, 550, 1300];
const INTRO_SAMPLE_MS = [0, 100, 200, 400, 650, 950, 1400, 2000, 2800, 3800, 5000];

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function detectScrollPlan(page) {
	return page.evaluate(() => {
		const pad = 8;
		const docX = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
		const docY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);

		let bestX = docX;
		let bestEl = null;

		for (const el of document.querySelectorAll('body *')) {
			if (!(el instanceof HTMLElement)) continue;
			const style = getComputedStyle(el);
			if (style.overflowX !== 'auto' && style.overflowX !== 'scroll' && style.overflow !== 'auto') {
				continue;
			}
			const extra = el.scrollWidth - el.clientWidth;
			if (extra > bestX + pad) {
				bestX = extra;
				bestEl = el;
			}
		}

		const mark = (el) => {
			if (!el) return null;
			const token = `me-scroll-${Math.random().toString(36).slice(2, 9)}`;
			el.setAttribute('data-me-scroll-target', token);
			return `[data-me-scroll-target="${token}"]`;
		};

		if (bestX > 64 && bestX >= docY * 0.9) {
			return { mode: 'x', extent: bestX, target: mark(bestEl), docX, docY };
		}
		if (docY > 64) {
			return { mode: 'y', extent: docY, target: null, docX, docY };
		}
		if (bestX > 64) {
			return { mode: 'x', extent: bestX, target: mark(bestEl), docX, docY };
		}
		return { mode: 'none', extent: 0, target: null, docX, docY };
	});
}

async function scrollTo(page, plan, t) {
	const ratio = Math.min(1, Math.max(0, t));
	await page.evaluate(
		({ mode, extent, target, ratio }) => {
			const pos = extent * ratio;
			if (mode === 'x') {
				if (target) {
					const el = document.querySelector(target);
					if (el) {
						el.scrollLeft = pos;
						return;
					}
				}
				window.scrollTo(pos, window.scrollY);
				return;
			}
			window.scrollTo(window.scrollX, pos);
		},
		{ mode: plan.mode, extent: plan.extent, target: plan.target, ratio },
	);
}

async function collectScrollFrames(page, plan, motion = {}) {
	const frameCount =
		typeof motion.scrollFrames === 'number'
			? motion.scrollFrames
			: scrollFrameCountForExtent(plan.extent, motion.scrollPxPerFrame);
	const frames = [];

	await scrollTo(page, plan, 0);
	await page.waitForTimeout(160);
	frames.push(await page.screenshot({ type: 'png' }));

	for (let i = 1; i <= frameCount; i++) {
		await scrollTo(page, plan, i / frameCount);
		await page.waitForTimeout(100);
		frames.push(await page.screenshot({ type: 'png' }));
	}

	await scrollTo(page, plan, 0);
	return frames;
}

async function discoverNavButtons(page) {
	return page.evaluate(() => {
		const roots = [
			...document.querySelectorAll('nav, header, [role="navigation"]'),
		];
		const scope = roots.length ? roots : [document.body];
		const seen = new Set();
		const found = [];

		for (const root of scope) {
			for (const el of root.querySelectorAll('button, a[href]')) {
				const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
				if (!text || text.length > 28) continue;
				if (el instanceof HTMLAnchorElement) {
					const href = el.getAttribute('href') || '';
					if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) {
						continue;
					}
				}
				const key = text.toLowerCase();
				if (seen.has(key)) continue;
				const box = el.getBoundingClientRect();
				if (box.width < 8 || box.height < 8) continue;
				const style = getComputedStyle(el);
				if (style.visibility === 'hidden' || style.display === 'none') continue;
				seen.add(key);
				found.push({
					text,
					kind: el instanceof HTMLAnchorElement ? 'link' : 'button',
				});
			}
		}

		return found;
	});
}

async function collectIntroFrames(page, sampleMs) {
	const times = Array.isArray(sampleMs) && sampleMs.length ? sampleMs : INTRO_SAMPLE_MS;
	const frames = [];
	let prev = 0;
	for (const targetMs of times) {
		await page.waitForTimeout(Math.max(0, targetMs - prev));
		prev = targetMs;
		frames.push(await page.screenshot({ type: 'png' }));
	}
	return frames;
}

async function collectNavInteractFrames(page, { skipInitialShot = false } = {}) {
	const frames = [];

	await page.evaluate(() => window.scrollTo(0, 0));
	if (!skipInitialShot) {
		await page.waitForTimeout(200);
		frames.push(await page.screenshot({ type: 'png' }));
	}

	const buttons = await discoverNavButtons(page);
	if (buttons.length < 2) {
		return null;
	}

	for (const { text, kind } of buttons.slice(0, CLICK_STEPS)) {
		try {
			const pattern = new RegExp(`^${escapeRegExp(text)}$`, 'i');
			const control =
				kind === 'link'
					? page.getByRole('link', { name: pattern }).first()
					: page.getByRole('button', { name: pattern }).first();
			if ((await control.count()) === 0) continue;
			await control.click({ timeout: 8000 });
			let prev = 0;
			for (const targetMs of NAV_TRANSITION_MS) {
				await page.waitForTimeout(targetMs - prev);
				prev = targetMs;
				frames.push(await page.screenshot({ type: 'png' }));
			}
		} catch {
			// skip stuck control
		}
	}

	if (frames.length < 3) return null;
	return frames;
}

async function collectClickthroughFrames(page, startUrl) {
	const origin = new URL(startUrl).origin;
	const frames = [];

	await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
	await page.waitForTimeout(500);
	await page.evaluate(() => window.scrollTo(0, 0));
	frames.push(await page.screenshot({ type: 'png' }));

	const links = await page.evaluate((originHref) => {
		const seen = new Set();
		const found = [];
		for (const a of document.querySelectorAll('a[href], button[data-href], [role="link"]')) {
			let href = a.getAttribute('href') || a.getAttribute('data-href') || '';
			if (!href && a instanceof HTMLButtonElement) {
				const onclick = a.getAttribute('onclick') || '';
				const m = onclick.match(/location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/);
				if (m) href = m[1];
			}
			if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) {
				continue;
			}
			let absolute;
			try {
				absolute = new URL(href, location.href).href;
			} catch {
				continue;
			}
			if (!absolute.startsWith(originHref)) continue;
			if (absolute === location.href || seen.has(absolute)) continue;

			const box = a.getBoundingClientRect();
			if (box.width < 4 || box.height < 4) continue;

			seen.add(absolute);
			found.push(absolute);
			if (found.length >= 8) break;
		}
		return found;
	}, origin);

	for (const href of links.slice(0, CLICK_STEPS)) {
		try {
			await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 25_000 });
			await page.waitForTimeout(CLICK_STEP_PAUSE_MS);
			frames.push(await page.screenshot({ type: 'png' }));
		} catch {
			// skip broken hops
		}
	}

	try {
		await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 });
	} catch {
		// keep collected frames
	}

	return frames;
}

const DEFAULT_MOTION_KEYS = ['ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];

async function collectKeyboardFrames(page, keys = DEFAULT_MOTION_KEYS) {
	const frames = [];
	const sequence = keys.length ? keys : DEFAULT_MOTION_KEYS;

	await page.waitForTimeout(250);
	frames.push(await page.screenshot({ type: 'png' }));

	for (const key of sequence.slice(0, CLICK_STEPS + 2)) {
		try {
			await page.keyboard.press(key);
			let prev = 0;
			for (const targetMs of NAV_TRANSITION_MS) {
				await page.waitForTimeout(targetMs - prev);
				prev = targetMs;
				frames.push(await page.screenshot({ type: 'png' }));
			}
		} catch {
			// skip unknown key
		}
	}

	return frames.length > 1 ? frames : [frames[0]];
}

const ICONIC_WAKE_MS = [400, 950, 1800, 3000, 4800, 7200, 9800, 12800, 15500];
const ICONIC_NAV_TRANSITION_MS = [450, 1100, 2500, 4200];
const ICONIC_NAV = ['01Games', '02Apps', '03Client', '04About', '05Contact'];

const MORIMICHI_WAKE_MS = [250, 550, 950, 1500, 2300, 3400, 5000, 7200, 10000, 13500];

async function collectMorimichiFrames(page, motion = {}) {
	const gate = page.locator('[data-login-gate]');
	const frames = [];

	await page.waitForTimeout(350);
	const gateVisible = await gate.isVisible({ timeout: 25_000 }).catch(() => false);
	if (gateVisible) {
		frames.push(await page.screenshot({ type: 'png' }));
		await gate.click({ timeout: 10_000 });
	}

	const sampleMs =
		Array.isArray(motion.introSampleMs) && motion.introSampleMs.length
			? motion.introSampleMs
			: MORIMICHI_WAKE_MS;
	let prev = 0;
	for (const targetMs of sampleMs) {
		await page.waitForTimeout(Math.max(0, targetMs - prev));
		prev = targetMs;
		frames.push(await page.screenshot({ type: 'png' }));
	}

	await page.waitForFunction(
		() => {
			const content = document.querySelector('[data-page-content]');
			return !content || !content.hasAttribute('inert');
		},
		null,
		{ timeout: 15_000 },
	).catch(() => {});

	const navFrames = await collectNavInteractFrames(page, { skipInitialShot: true });
	if (navFrames) {
		return [...frames, ...navFrames];
	}
	return frames.length ? frames : null;
}

async function collectIconicFrames(page) {
	const frames = [];

	const onGate = await page.getByText(/音が出ますがよろしいですか/).isVisible().catch(() => false);
	if (!onGate) {
		return null;
	}

	frames.push(await page.screenshot({ type: 'png' }));
	await page.getByRole('button', { name: 'はい' }).click();

	let prev = 0;
	for (const targetMs of ICONIC_WAKE_MS) {
		await page.waitForTimeout(targetMs - prev);
		prev = targetMs;
		frames.push(await page.screenshot({ type: 'png' }));
	}

	for (const label of ICONIC_NAV) {
		try {
			const btn = page.getByRole('button', { name: new RegExp(label, 'i') }).first();
			if ((await btn.count()) === 0) continue;
			await btn.click({ timeout: 6000 });
			let stepPrev = 0;
			for (const targetMs of ICONIC_NAV_TRANSITION_MS) {
				await page.waitForTimeout(targetMs - stepPrev);
				stepPrev = targetMs;
				frames.push(await page.screenshot({ type: 'png' }));
			}
		} catch {
			// skip
		}
	}

	return frames.length > 1 ? frames : null;
}

export async function captureMotionFrames(page, startUrl, plan, motion = {}) {
	if (motion.motionMode === 'morimichi') {
		const morimichiFrames = await collectMorimichiFrames(page, motion);
		if (morimichiFrames) return morimichiFrames;
	}
	if (motion.motionMode === 'iconic') {
		const iconicFrames = await collectIconicFrames(page);
		if (iconicFrames) return iconicFrames;
	}
	if (motion.motionMode === 'keyboard') {
		return collectKeyboardFrames(page, motion.motionKeys);
	}
	if (plan.mode === 'none') {
		let frames = [];
		if (motion.motionIntro) {
			frames = await collectIntroFrames(page, motion.introSampleMs);
		}
		const navFrames = await collectNavInteractFrames(page, { skipInitialShot: motion.motionIntro === true });
		if (navFrames) return frames.length ? [...frames, ...navFrames] : navFrames;
		if (frames.length) return frames;
		return collectClickthroughFrames(page, startUrl);
	}
	if (motion.motionIntro) {
		const intro = await collectIntroFrames(page, motion.introSampleMs);
		const scroll = await collectScrollFrames(page, plan, motion);
		return [...intro, ...scroll];
	}
	return collectScrollFrames(page, plan, motion);
}

export async function writeScrollGif(framePngs, dest, { width, height, gifDelayMs }) {
	const delayMs = typeof gifDelayMs === 'number' && gifDelayMs > 0 ? gifDelayMs : GIF_DELAY_MS;
	if (!framePngs.length) {
		throw new Error('no frames for gif');
	}

	const encoder = GIFEncoder();
	let outW = width;
	let outH = height;

	for (let i = 0; i < framePngs.length; i++) {
		const { data, info } = await sharp(framePngs[i])
			.resize(width, height, { fit: 'cover', position: 'top' })
			.ensureAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });

		outW = info.width;
		outH = info.height;
		const palette = quantize(data, 256);
		const index = applyPalette(data, palette);
		encoder.writeFrame(index, info.width, info.height, {
			palette,
			delay: i === framePngs.length - 1 ? delayMs * 3 : delayMs,
		});
	}

	encoder.finish();
	await writeFile(dest, Buffer.from(encoder.bytes()));
}