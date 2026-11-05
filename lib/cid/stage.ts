import { cidUrl, type CidSlug } from './profile';

export function cidStagePolicy(slug: CidSlug) {
  return `frame-ancestors ${new URL(cidUrl(slug)).origin}; object-src 'none'; base-uri 'none'`;
}
