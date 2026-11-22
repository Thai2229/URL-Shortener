import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');

describe('vercel.json', () => {
  const cfg = JSON.parse(read('vercel.json'));

  it('rewrites everything to /api', () => {
    expect(cfg.rewrites).toContainEqual({
      source: '/(.*)',
      destination: '/api',
    });
  });
  it('has framework null and the vercel-build command', () => {
    expect(cfg.framework).toBeNull();
    expect(cfg.buildCommand).toBe('npm run vercel-build');
  });
  it('has one daily cron for the flush route', () => {
    expect(cfg.crons).toHaveLength(1);
    expect(cfg.crons[0].path).toBe('/api/cron/flush');
    expect(cfg.crons[0].schedule).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
  });
});

describe('api/index.js', () => {
  it('re-exports the default from dist/vercel.js', () => {
    expect(existsSync(new URL('api/index.js', root))).toBe(true);
    const text = read('api/index.js');
    expect(text).toContain('../dist/vercel.js');
    expect(text).toContain('export default');
  });
});

describe('package.json and build script', () => {
  const pkg = JSON.parse(read('package.json'));

  it('pins node 22.x and defines vercel-build', () => {
    expect(pkg.engines.node).toBe('22.x');
    expect(typeof pkg.scripts['vercel-build']).toBe('string');
  });
  it('has scripts/vercel-build.sh mentioning VERCEL_ENV and migrate', () => {
    expect(existsSync(new URL('scripts/vercel-build.sh', root))).toBe(true);
    const text = read('scripts/vercel-build.sh');
    expect(text).toContain('VERCEL_ENV');
    expect(text).toContain('migrate');
  });
});
