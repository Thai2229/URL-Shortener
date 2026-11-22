import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');

describe('public/index.html', () => {
  const html = existsSync(new URL('public/index.html', root))
    ? read('public/index.html')
    : '';
  it('exists', () => {
    expect(existsSync(new URL('public/index.html', root))).toBe(true);
  });
  it('has the form, url input, and result/error elements', () => {
    expect(html).toContain('<form id="shorten-form"');
    expect(html).toMatch(
      /<input\b(?=[^>]*name="url")(?=[^>]*type="url")[^>]*>/,
    );
    expect(html).toContain('id="short-url"');
    expect(html).toContain('id="copy"');
    expect(html).toMatch(
      /<[^>]*id="error"[^>]*role="alert"|<[^>]*role="alert"[^>]*id="error"/,
    );
  });
  it('has title, html lang and viewport meta', () => {
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    expect(html).toMatch(/<html[^>]*\blang=/);
    expect(html).toMatch(/<meta[^>]*name="viewport"/);
  });
  it('has no inline scripts, style attributes or event handlers', () => {
    const scripts = [
      ...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi),
    ];
    for (const s of scripts) {
      expect(s[1]).toMatch(/\bsrc=/);
      expect((s[2] ?? '').trim()).toBe('');
    }
    expect(html).not.toMatch(/<script\b(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });
  it('references only relative or same-origin resources', () => {
    expect(html).not.toMatch(
      /\b(src|href|action)\s*=\s*["']?\s*(https?:)?\/\//i,
    );
  });
});

describe('public/app.js', () => {
  const exists = existsSync(new URL('public/app.js', root));
  const js = exists ? read('public/app.js') : '';
  it('exists and calls fetch on /api/links', () => {
    expect(exists).toBe(true);
    expect(js).toMatch(/fetch\(\s*['"]\/api\/links['"]/);
  });
  it('only sets the result href when shortUrl is http(s)', () => {
    const regexCheck = /\/\^https\?:\\\/\\\//.test(js);
    const urlCheck = /new\s+URL\([^)]*shortUrl[^)]*\)\.protocol/.test(js);
    expect(regexCheck || urlCheck).toBe(true);
  });
  it('avoids eval, new Function, innerHTML and document.write', () => {
    expect(js).not.toMatch(/\beval\s*\(/);
    expect(js).not.toMatch(/new\s+Function\b/);
    expect(js).not.toMatch(/innerHTML/);
    expect(js).not.toMatch(/document\.write/);
  });
});

describe('public/styles.css and favicon', () => {
  it('styles.css exists with no @import or remote url()', () => {
    expect(existsSync(new URL('public/styles.css', root))).toBe(true);
    const css = read('public/styles.css');
    expect(css).not.toMatch(/@import/i);
    expect(css).not.toMatch(/url\(\s*["']?\s*(https?:)?\/\//i);
  });
  it('favicon.svg exists and is an svg', () => {
    expect(existsSync(new URL('public/favicon.svg', root))).toBe(true);
    expect(read('public/favicon.svg')).toContain('<svg');
  });
});

describe('packaging', () => {
  it('Dockerfile copies public into the runtime image', () => {
    expect(read('Dockerfile')).toMatch(/^COPY\s+(--\S+\s+)*public\b.*$/m);
  });
  it('.vercelignore does not exclude public', () => {
    const lines = read('.vercelignore')
      .split('\n')
      .map((l) => l.trim().replace(/^\//, '').replace(/\/$/, ''));
    expect(lines).not.toContain('public');
    expect(lines).not.toContain('public/*');
    expect(lines).not.toContain('public/**');
  });
  it('vercel.json still rewrites everything to /api', () => {
    expect(JSON.parse(read('vercel.json')).rewrites).toContainEqual({
      source: '/(.*)',
      destination: '/api',
    });
  });
  it('package.json files field, if present, includes public', () => {
    const pkg = JSON.parse(read('package.json'));
    if (pkg.files !== undefined) {
      expect(pkg.files.some((f: string) => /^\.?\/?public\/?/.test(f))).toBe(
        true,
      );
    }
  });
  it('home route module exists and resolves public/ from the repo root', () => {
    expect(existsSync(new URL('src/routes/home.ts', root))).toBe(true);
    expect(read('src/routes/home.ts')).toContain('../../public');
  });
  it('buildApp found the files when imported via tsx/vitest', async () => {
    const { buildApp } = await import('../src/app.js');
    const { testConfig } = await import('./helpers/config.js');
    const { createPool } = await import('../src/db/pool.js');
    const { testDatabaseUrl } = await import('./helpers/db.js');
    const pool = createPool(testDatabaseUrl());
    const app = buildApp(testConfig({}), { db: pool });
    try {
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('id="shorten-form"');
    } finally {
      await app.close();
      await pool.end();
    }
  });
});
