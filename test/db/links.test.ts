import { describe, expect, it } from 'vitest';
import { findLinkByCode, insertLink } from '../../src/db/links.js';
import { uniqueCode, usePool } from '../helpers/db.js';

describe('links data layer', () => {
  const pool = usePool();

  it('insertLink returns the full mapped Link with defaults', async () => {
    const code = uniqueCode();
    const link = await insertLink(pool, {
      code,
      targetUrl: 'https://example.com/a',
    });
    expect(link).not.toBeNull();
    expect(typeof link?.id).toBe('string');
    expect(link?.id).toMatch(/^\d+$/);
    expect(link?.code).toBe(code);
    expect(link?.targetUrl).toBe('https://example.com/a');
    expect(link?.createdAt).toBeInstanceOf(Date);
    expect(link?.expiresAt).toBeNull();
    expect(link?.clickCount).toBe(0);
    expect(typeof link?.clickCount).toBe('number');
  });

  it('insertLink stores a given expiresAt as a Date', async () => {
    const expiresAt = new Date('2030-01-02T03:04:05.000Z');
    const link = await insertLink(pool, {
      code: uniqueCode(),
      targetUrl: 'https://example.com/b',
      expiresAt,
    });
    expect(link?.expiresAt).toBeInstanceOf(Date);
    expect(link?.expiresAt?.getTime()).toBe(expiresAt.getTime());
  });

  it('insertLink treats expiresAt null as no expiry', async () => {
    const link = await insertLink(pool, {
      code: uniqueCode(),
      targetUrl: 'https://example.com/n',
      expiresAt: null,
    });
    expect(link?.expiresAt).toBeNull();
  });

  it('insertLink accepts boundary values (32 char code, 2048 char url)', async () => {
    const code = 'a'.repeat(32);
    const targetUrl = 'https://example.com/' + 'x'.repeat(2048 - 20);
    expect(targetUrl).toHaveLength(2048);
    await pool.query('DELETE FROM links WHERE code = $1', [code]);
    const link = await insertLink(pool, { code, targetUrl });
    expect(link?.code).toBe(code);
    expect(link?.targetUrl).toHaveLength(2048);
    await pool.query('DELETE FROM links WHERE code = $1', [code]);
  });

  it('insertLink returns null on duplicate code and keeps the original row', async () => {
    const code = uniqueCode();
    const first = await insertLink(pool, {
      code,
      targetUrl: 'https://example.com/first',
    });
    const second = await insertLink(pool, {
      code,
      targetUrl: 'https://example.com/second',
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const found = await findLinkByCode(pool, code);
    expect(found).toEqual(first);
    expect(found?.targetUrl).toBe('https://example.com/first');
  });

  it('findLinkByCode returns the stored link', async () => {
    const code = uniqueCode();
    const inserted = await insertLink(pool, {
      code,
      targetUrl: 'https://example.com/find',
    });
    const found = await findLinkByCode(pool, code);
    expect(found).toEqual(inserted);
    expect(found?.createdAt).toBeInstanceOf(Date);
  });

  it('findLinkByCode returns null for an unknown code', async () => {
    expect(await findLinkByCode(pool, uniqueCode('missing'))).toBeNull();
  });

  it('findLinkByCode returns expired links too', async () => {
    const code = uniqueCode();
    const expiresAt = new Date(Date.now() - 60_000);
    await insertLink(pool, {
      code,
      targetUrl: 'https://example.com/old',
      expiresAt,
    });
    const found = await findLinkByCode(pool, code);
    expect(found?.code).toBe(code);
    expect(found?.expiresAt?.getTime()).toBe(expiresAt.getTime());
  });

  it.each([
    ['space', 'bad code'],
    ['slash', 'bad/code'],
    ['dot', 'bad.code'],
    ['unicode', 'café'],
    ['emoji', 'x\u{1F600}'],
    ['empty', ''],
    ['sql chars', "a'; DROP TABLE links;--"],
  ])('rejects a code with invalid characters (%s)', async (_name, code) => {
    await expect(
      insertLink(pool, { code, targetUrl: 'https://example.com/c' }),
    ).rejects.toThrow();
  });

  it('rejects a code longer than 32 chars', async () => {
    await expect(
      insertLink(pool, {
        code: 'a'.repeat(33),
        targetUrl: 'https://example.com/d',
      }),
    ).rejects.toThrow();
  });

  it('rejects a target_url longer than 2048 chars', async () => {
    const targetUrl = 'https://example.com/' + 'x'.repeat(2049 - 20);
    expect(targetUrl).toHaveLength(2049);
    await expect(
      insertLink(pool, { code: uniqueCode(), targetUrl }),
    ).rejects.toThrow();
  });
});
