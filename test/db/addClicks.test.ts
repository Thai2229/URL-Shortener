import { afterEach, describe, expect, it, vi } from 'vitest';
import { addClicks, findLinkByCode, insertLink } from '../../src/db/links.js';
import { uniqueCode, usePool } from '../helpers/db.js';

describe('addClicks', () => {
  const pool = usePool();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function clicks(code: string) {
    return (await findLinkByCode(pool, code))?.clickCount;
  }

  async function make(prefix = 'ac') {
    const code = uniqueCode(prefix);
    await insertLink(pool, { code, targetUrl: 'https://example.com/ac' });
    return code;
  }

  it('adds to the existing count and is cumulative', async () => {
    const code = await make();
    expect(await addClicks(pool, { [code]: 3 })).toBe(1);
    expect(await clicks(code)).toBe(3);
    expect(await addClicks(pool, { [code]: 4 })).toBe(1);
    expect(await clicks(code)).toBe(7);
  });

  it('updates several codes in one call', async () => {
    const a = await make();
    const b = await make();
    const c = await make();
    expect(await addClicks(pool, { [a]: 1, [b]: 20, [c]: 300 })).toBe(3);
    expect(await clicks(a)).toBe(1);
    expect(await clicks(b)).toBe(20);
    expect(await clicks(c)).toBe(300);
  });

  it('ignores unknown codes and counts only updated rows', async () => {
    const code = await make();
    const ghost = uniqueCode('ghost');
    expect(await addClicks(pool, { [code]: 2, [ghost]: 9 })).toBe(1);
    expect(await clicks(code)).toBe(2);
    expect(await findLinkByCode(pool, ghost)).toBeNull();
    expect(await addClicks(pool, { [ghost]: 1 })).toBe(0);
  });

  it('returns 0 without querying for an empty object', async () => {
    const spy = vi.spyOn(pool, 'query');
    expect(await addClicks(pool, {})).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('applies a 5000-code batch in a single statement', async () => {
    const codes = Array.from({ length: 5000 }, (_, i) =>
      uniqueCode('b').slice(0, 24).concat(String(i)),
    );
    await pool.query(
      `INSERT INTO links (code, target_url) SELECT c, 'https://example.com/bulk' FROM unnest($1::text[]) AS c`,
      [codes],
    );
    const counts: Record<string, number> = {};
    codes.forEach((code, i) => {
      counts[code] = i + 1;
    });
    const spy = vi.spyOn(pool, 'query');
    const start = Date.now();
    expect(await addClicks(pool, counts)).toBe(5000);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(spy).toHaveBeenCalledTimes(1);
    const { rows } = await pool.query(
      'SELECT sum(click_count)::int AS s FROM links WHERE code = ANY($1)',
      [codes],
    );
    expect(rows[0].s).toBe((5000 * 5001) / 2);
  });

  it('counts clicks on expired links too', async () => {
    const code = uniqueCode('ex');
    await insertLink(pool, {
      code,
      targetUrl: 'https://example.com/old',
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await addClicks(pool, { [code]: 5 })).toBe(1);
    expect(await clicks(code)).toBe(5);
  });

  it('passes values as parameters (SQL metacharacters are just unknown codes)', async () => {
    const code = await make();
    const evil = "x'; DROP TABLE links;--";
    expect(await addClicks(pool, { [evil]: 1, [code]: 1 })).toBe(1);
    expect(await clicks(code)).toBe(1);
  });
});
