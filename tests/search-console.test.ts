import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// The owner's Google Search Console property for https://brainrottcg.pages.dev/ is verified by this
// tag in index.html (docs/HOSTING.md, Caching). Removing or changing it unverifies the property.
const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');

it('keeps the Search Console verification tag', () => {
  const tags = [...html.matchAll(/<meta\s+name="google-site-verification"\s+content="([^"]*)"/g)];
  expect(tags.map((tag) => tag[1])).toEqual(['5u_ZfFJ-JUYJLAsQTwOMmV3MlHI-HTFLUTxlGK-VH4A']);
});
