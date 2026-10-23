import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin, type Rollup } from 'vite';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { analyticsSnippet, analyticsToken, BEACON_URL, cloudflareAnalytics, withAnalytics } from './cloudflare-analytics.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const INDEX_HTML = readFileSync(`${ROOT}index.html`, 'utf8');
const TOKEN = '0123456789abcdef0123456789abcdef';
const SNIPPET = `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${TOKEN}"}'></script>`;

const MALFORMED = [
  ' ', `${TOKEN} `, ` ${TOKEN}`, `${TOKEN}\n`, TOKEN.toUpperCase(), TOKEN.slice(1), `${TOKEN}0`, `${TOKEN.slice(1)}g`,
  `${TOKEN.slice(2)}"}`, `${TOKEN.slice(1)}'`, `${TOKEN.slice(1)}<`, '"}\'></script><script>alert(1)</script>', 'undefined', 'null',
];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('the token', () => {
  it('is unset when the variable is missing or empty', () => {
    expect(analyticsToken(undefined)).toBeNull();
    expect(analyticsToken('')).toBeNull();
  });

  it('is 32 lowercase hex digits', () => {
    expect(analyticsToken(TOKEN)).toBe(TOKEN);
  });

  it.each(MALFORMED)('fails on %j', (value) => {
    expect(() => analyticsToken(value)).toThrow(/CLOUDFLARE_ANALYTICS_TOKEN must be/);
    expect(() => cloudflareAnalytics(value)).toThrow(/CLOUDFLARE_ANALYTICS_TOKEN must be/);
  });
});

describe('the snippet', () => {
  it("is Cloudflare's, loading the beacon with the token", () => {
    expect(analyticsSnippet(TOKEN)).toBe(SNIPPET);
    expect(BEACON_URL).toBe('https://static.cloudflareinsights.com/beacon.min.js');
  });

  it('goes into index.html once, just before </body>, and changes nothing else', () => {
    const html = withAnalytics(INDEX_HTML, TOKEN);
    expect(html.split(BEACON_URL)).toHaveLength(2);
    expect(html).toContain(`${SNIPPET}\n</body>`);
    expect(html.replace(`${SNIPPET}\n`, '')).toBe(INDEX_HTML);
  });

  it('needs exactly one </body> and no beacon already there', () => {
    expect(() => withAnalytics('<p>no end</p>', TOKEN)).toThrow(/exactly one <\/body>/);
    expect(() => withAnalytics('</body></body>', TOKEN)).toThrow(/exactly one <\/body>/);
    expect(() => withAnalytics(withAnalytics(INDEX_HTML, TOKEN), TOKEN)).toThrow(/already loads the beacon/);
  });
});

describe('the Vite plugin', () => {
  it('has no hooks when the variable is unset or empty', () => {
    expect(cloudflareAnalytics(undefined)).toEqual({ name: 'cloudflare-analytics' });
    expect(cloudflareAnalytics('')).toEqual({ name: 'cloudflare-analytics' });
  });

  it("is in the site's config, reading CLOUDFLARE_ANALYTICS_TOKEN", async () => {
    const pluginIn = async () => {
      // A computed specifier keeps vite.config.ts (typed for the app's tsconfig) out of this typecheck.
      const url = new URL('../vite.config.ts', import.meta.url).href;
      const { default: config } = (await import(/* @vite-ignore */ url)) as { default: { plugins: Plugin[] } };
      vi.resetModules();
      return config.plugins.flat().filter((plugin) => plugin && plugin.name === 'cloudflare-analytics');
    };
    vi.stubEnv('CLOUDFLARE_ANALYTICS_TOKEN', undefined);
    expect(await pluginIn()).toEqual([{ name: 'cloudflare-analytics' }]);
    vi.stubEnv('CLOUDFLARE_ANALYTICS_TOKEN', '');
    expect(await pluginIn()).toEqual([{ name: 'cloudflare-analytics' }]);
    vi.stubEnv('CLOUDFLARE_ANALYTICS_TOKEN', TOKEN);
    const [set] = await pluginIn();
    expect(set).toMatchObject({ apply: 'build', transformIndexHtml: { order: 'post' } });
    vi.stubEnv('CLOUDFLARE_ANALYTICS_TOKEN', `${TOKEN}"`);
    await expect(pluginIn()).rejects.toThrow(/CLOUDFLARE_ANALYTICS_TOKEN must be/);
  });
});

describe('a Vite build', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cloudflare-analytics-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html>\n<html>\n  <body>\n    <div id="root"></div>\n'
    + '    <script type="module" src="/main.js"></script>\n  </body>\n</html>\n');
  writeFileSync(path.join(dir, 'main.js'), "document.getElementById('root').textContent = 'hi';\n");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Every file the build writes, by name. */
  const built = async (plugins: Plugin[]): Promise<Map<string, string>> => {
    const output = await build({ root: dir, configFile: false, logLevel: 'silent', plugins, build: { write: false } }) as Rollup.RollupOutput;
    return new Map(output.output.map((file) => [file.fileName, file.type === 'asset' ? String(file.source) : file.code]));
  };

  it('writes the same bytes without the variable as with no analytics at all', async () => {
    const today = await built([]);
    expect(await built([cloudflareAnalytics(undefined)])).toEqual(today);
    expect(await built([cloudflareAnalytics('')])).toEqual(today);
  });

  it('with a token, adds one snippet to the page and changes nothing else', async () => {
    const today = await built([]);
    const withToken = await built([cloudflareAnalytics(TOKEN)]);
    expect([...withToken.keys()]).toEqual([...today.keys()]);
    const page = withToken.get('index.html')!;
    expect(page.split(BEACON_URL)).toHaveLength(2);
    expect(page).toContain(`${SNIPPET}\n</body>`);
    expect(page.replace(`${SNIPPET}\n`, '')).toBe(today.get('index.html'));
    for (const [name, text] of today) if (name !== 'index.html') expect(withToken.get(name)).toBe(text);
  });
});
