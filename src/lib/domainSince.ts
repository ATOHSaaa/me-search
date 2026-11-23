/** ISO 日時をカード用の `since YYYY-MM-DD` にする（UTC）。 */
export function formatSinceLabel(iso?: string): string | null {
	if (!iso?.trim()) return null;
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return null;
	const d = new Date(t);
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, '0');
	const day = String(d.getUTCDate()).padStart(2, '0');
	return `since ${y}-${m}-${day}`;
}