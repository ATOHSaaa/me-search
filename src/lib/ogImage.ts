import { getImage } from 'astro:assets';
import ogSource from '../assets/og-image.svg';

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

export async function resolveOgImageUrl(origin: URL) {
	const optimized = await getImage({
		src: ogSource,
		width: OG_WIDTH,
		height: OG_HEIGHT,
		format: 'png',
		quality: 88,
	});

	return {
		url: new URL(optimized.src, origin).href,
		width: OG_WIDTH,
		height: OG_HEIGHT,
	};
}