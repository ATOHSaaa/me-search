/** カード絞り込み用。sites.json の `tags` は表示ラベル（例: イラストレーター）の配列。 */
export function normalizeTags(tags: unknown): string[] {
	if (!Array.isArray(tags)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of tags) {
		const label = String(raw).replace(/\s+/g, ' ').trim();
		if (!label || seen.has(label)) continue;
		seen.add(label);
		out.push(label);
	}
	return out;
}

export function collectAllTags(sites: { tags?: unknown }[]): string[] {
	const seen = new Set<string>();
	for (const site of sites) {
		for (const tag of normalizeTags(site.tags)) {
			seen.add(tag);
		}
	}
	return [...seen].sort((a, b) => a.localeCompare(b, 'ja'));
}