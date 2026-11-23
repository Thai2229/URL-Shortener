import { describe, expect, it } from 'vitest';
import { generateCode } from '../src/code.js';

describe('generateCode', () => {
  it('defaults to 7 characters', () => {
    expect(generateCode()).toHaveLength(7);
  });

  it.each([1, 10, 32])('honours a custom length (%i)', (length) => {
    expect(generateCode(length)).toHaveLength(length);
  });

  it('only uses base62 characters', () => {
    for (let i = 0; i < 500; i++) {
      expect(generateCode(32)).toMatch(/^[0-9A-Za-z]{32}$/);
    }
  });

  it('does not repeat over 1000 draws', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      codes.add(generateCode());
    }
    expect(codes.size).toBe(1000);
  });

  it('uses the whole alphabet roughly evenly (unbiased)', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 620; i++) {
      for (const ch of generateCode(100)) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }
    // 62 000 draws, ~1000 per char; a modulo-biased generator skews far more.
    expect(counts.size).toBe(62);
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(800);
      expect(n).toBeLessThan(1200);
    }
  });
});
