import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('does not leak the connection string and exits non-zero on failure', () => {
  const result = spawnSync('npx', ['tsx', 'src/scripts/migrate.ts'], {
    cwd: new URL('../', import.meta.url).pathname,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: 'postgres://user:secretpw@127.0.0.1:1/db',
    },
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).not.toContain('secretpw');
  expect(result.stdout).not.toContain('secretpw');
}, 70_000);
