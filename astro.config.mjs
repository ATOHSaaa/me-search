// @ts-check
import { defineConfig } from 'astro/config';

/** @param {string | undefined} full */
function githubPagesBase(full) {
	if (!full) return undefined;
	const repo = full.split('/')[1];
	if (!repo) return undefined;
	if (repo.endsWith('.github.io')) return '/';
	return `/${repo}`;
}

/** @param {string | undefined} full */
function githubPagesSite(full) {
	if (!full) return undefined;
	const [owner, repo] = full.split('/');
	if (!owner || !repo) return undefined;
	if (repo.endsWith('.github.io')) return `https://${repo}`;
	return `https://${owner}.github.io/${repo}`;
}

const repository = process.env.GITHUB_REPOSITORY;
const base = process.env.ASTRO_BASE ?? githubPagesBase(repository) ?? '/';
const site = process.env.ASTRO_SITE ?? githubPagesSite(repository);

// https://astro.build/config
export default defineConfig({
	...(site ? { site } : {}),
	base,
});