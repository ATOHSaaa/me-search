function decodeEntities(text: string) {
	return text
		.replace(/&amp;/gi, '&')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function parseTitleFromHtml(html: string) {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (!match) return '';
	return decodeEntities(match[1].replace(/\s+/g, ' ').trim());
}

export async function fetchSiteTitle(url: string, timeoutMs = 12_000) {
	const signal = AbortSignal.timeout(timeoutMs);
	try {
		const res = await fetch(url, {
			redirect: 'follow',
			signal,
			headers: {
				Accept: 'text/html',
				'User-Agent':
					'Mozilla/5.0 (compatible; me-search/1.0; +https://github.com/astro)',
			},
		});
		if (!res.ok) return '';
		const html = await res.text();
		return parseTitleFromHtml(html);
	} catch {
		return '';
	}
}