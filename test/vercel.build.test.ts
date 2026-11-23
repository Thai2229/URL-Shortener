import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function runBuild(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-npm-'));
  dirs.push(dir);
  const marker = join(dir, 'called');
  const npm = join(dir, 'npm');
  writeFileSync(npm, `#!/bin/sh\necho "$@" >> "${marker}"\nexit 0\n`);
  chmodSync(npm, 0o755);
  const result = spawnSync('sh', ['scripts/vercel-build.sh'], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH}`, ...env },
  });
  return { result, npmCalled: existsSync(marker) };
}

describe('scripts/vercel-build.sh', () => {
  it('fails before building when production would migrate through a pooled URL', () => {
    const { result, npmCalled } = runBuild({
      VERCEL_ENV: 'production',
      DATABASE_URL:
        'postgres://u:p@ep-cool-123-pooler.us-east-2.aws.neon.tech/db',
    });
    expect(result.status).not.toBe(0);
    const out = `${result.stdout}${result.stderr}`;
    expect(out).toMatch(/MIGRATE_DATABASE_URL/);
    expect(out).toMatch(/DATABASE_URL_UNPOOLED/);
    expect(out).not.toContain('u:p@');
    expect(npmCalled).toBe(false);
  });

  it('still skips migrations for preview deploys', () => {
    const { result, npmCalled } = runBuild({
      VERCEL_ENV: 'preview',
      DATABASE_URL:
        'postgres://u:p@ep-cool-123-pooler.us-east-2.aws.neon.tech/db',
    });
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/skipping/i);
    expect(npmCalled).toBe(true);
  });
});
