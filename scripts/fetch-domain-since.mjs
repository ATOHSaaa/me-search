import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sitesPath = path.join(root, 'src/data/sites.json');

const SKIP_SUFFIXES = ['.github.io', 'scrapbox.io'];

function registrableDomain(hostname) {
	const host = hostname.replace(/^www\./, '').toLowerCase();
	for (const suffix of SKIP_SUFFIXES) {
		if (host === suffix.slice(1) || host.endsWith(suffix)) return null;
	}
	return host;
}

function rdapUrl(domain) {
	const labels = domain.split('.');
	const tld = labels.at(-1);
	const sld = labels.at(-2);
	if (!tld || !sld) return null;

	if (tld === 'jp' || tld === 'me') return null;
	if (tld === 'com') return `https://rdap.verisign.com/com/v1/domain/${domain.toLowerCase()}`;
	if (tld === 'net') return `https://rdap.verisign.com/net/v1/domain/${domain.toLowerCase()}`;
	if (tld === 'dev' || tld.startsWith('xn--')) {
		return `https://pubapi.registry.google/rdap/domain/${domain.toLowerCase()}`;
	}

	return `https://rdap.verisign.com/com/v1/domain/${domain.toLowerCase()}`;
}

async function whoisRegistrationDate(domain) {
	const tld = domain.split('.').at(-1);
	const args =
		tld === 'jp'
			? ['-h', 'whois.jprs.jp', domain]
			: tld === 'me'
				? ['-h', 'whois.nic.me', domain]
				: [domain];
	const { stdout } = await execFileAsync('whois', args, {
		timeout: 20_000,
		maxBuffer: 2_000_000,
	});
	const jp = stdout.match(/\[登録年月日\]\s+(\d{4}\/\d{1,2}\/\d{1,2})/);
	if (jp) {
		const [y, mo, d] = jp[1].split('/').map((x) => Number.parseInt(x, 10));
		return new Date(Date.UTC(y, mo - 1, d)).toISOString();
	}
	const creation = stdout.match(/Creation Date:\s*([0-9T:\-+.Z]+)/i);
	if (creation) return toStoredIso(creation[1].trim());
	return null;
}

function pickRegistrationDate(rdap) {
	const events = rdap?.events;
	if (!Array.isArray(events)) return null;
	const preferred = ['registration', 'domain registration'];
	for (const action of preferred) {
		const hit = events.find((e) => e?.eventAction?.toLowerCase() === action);
		if (hit?.eventDate) return hit.eventDate;
	}
	const any = events.find((e) => /regist/i.test(e?.eventAction || '') && e?.eventDate);
	return any?.eventDate ?? null;
}

async function fetchRdap(domain) {
	const url = rdapUrl(domain);
	if (!url) throw new Error('no rdap url');
	const res = await fetch(url, {
		headers: { Accept: 'application/rdap+json, application/json' },
		signal: AbortSignal.timeout(25_000),
	});
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
	return res.json();
}

function toStoredIso(eventDate) {
	const t = Date.parse(eventDate);
	if (!Number.isFinite(t)) return null;
	return new Date(t).toISOString();
}

const sites = JSON.parse(await readFile(sitesPath, 'utf8'));
const only = new Set(process.argv.slice(2));
const selected = only.size ? sites.filter((site) => only.has(site.shot)) : sites;
const updates = new Map();

for (const site of selected) {
	let hostname;
	try {
		hostname = new URL(site.url).hostname;
	} catch {
		console.warn('skip bad url', site.shot);
		continue;
	}
	const domain = registrableDomain(hostname);
	if (!domain) {
		console.log('skip platform', site.shot, hostname);
		continue;
	}
	let iso = null;
	let source = '';
	try {
		const url = rdapUrl(domain);
		if (url) {
			const rdap = await fetchRdap(domain);
			const raw = pickRegistrationDate(rdap);
			iso = raw ? toStoredIso(raw) : null;
			if (iso) source = 'rdap';
		}
	} catch {
		/* RDAP 不可の TLD やレート制限時は whois へ */
	}

	if (!iso) {
		try {
			iso = await whoisRegistrationDate(domain);
			if (iso) source = 'whois';
		} catch (error) {
			console.warn('fail', site.shot, domain, error instanceof Error ? error.message : error);
		}
	}

	if (iso) {
		updates.set(site.shot, iso);
		console.log('ok', site.shot, domain, iso.slice(0, 10), source);
	} else {
		console.warn('no date', site.shot, domain);
	}
	await new Promise((r) => setTimeout(r, 250));
}

if (updates.size === 0) {
	console.log('no updates');
	process.exit(0);
}

const next = sites.map((entry) => {
	const iso = updates.get(entry.shot);
	if (!iso) return entry;
	return iso === entry.domainSince ? entry : { ...entry, domainSince: iso };
});

await writeFile(sitesPath, `${JSON.stringify(next, null, 2)}\n`);
console.log(`updated ${updates.size} entries`);