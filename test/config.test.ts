import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({})).toEqual({
      port: 3000,
      host: '0.0.0.0',
      logLevel: 'info',
      baseUrl: 'http://localhost:3000',
      databaseUrl: undefined,
      redisUrl: undefined,
      rateLimit: {
        enabled: true,
        windowSeconds: 60,
        createMax: 20,
        redirectMax: 600,
        readMax: 120,
      },
      trustProxy: false,
    });
  });

  it('reads values from env', () => {
    const c = loadConfig({
      PORT: '8080',
      DATABASE_URL: 'postgres://x',
      LOG_LEVEL: 'debug',
    });
    expect(c.port).toBe(8080);
    expect(c.databaseUrl).toBe('postgres://x');
    expect(c.logLevel).toBe('debug');
  });

  it('throws on invalid PORT', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
  });

  it('throws on invalid LOG_LEVEL or BASE_URL', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
    expect(() => loadConfig({ BASE_URL: 'not a url' })).toThrow(/BASE_URL/);
  });

  describe('rate limit', () => {
    it('reads values from env', () => {
      const c = loadConfig({
        RATE_LIMIT_ENABLED: 'true',
        RATE_LIMIT_WINDOW_SECONDS: '30',
        RATE_LIMIT_CREATE_MAX: '5',
        RATE_LIMIT_REDIRECT_MAX: '50',
        RATE_LIMIT_READ_MAX: '25',
      });
      expect(c.rateLimit).toEqual({
        enabled: true,
        windowSeconds: 30,
        createMax: 5,
        redirectMax: 50,
        readMax: 25,
      });
    });

    it.each(['false', '0'])('disables with RATE_LIMIT_ENABLED=%s', (v) => {
      expect(loadConfig({ RATE_LIMIT_ENABLED: v }).rateLimit.enabled).toBe(
        false,
      );
    });

    it('stays enabled for RATE_LIMIT_ENABLED=true or 1', () => {
      expect(loadConfig({ RATE_LIMIT_ENABLED: 'true' }).rateLimit.enabled).toBe(
        true,
      );
      expect(loadConfig({ RATE_LIMIT_ENABLED: '1' }).rateLimit.enabled).toBe(
        true,
      );
    });

    it.each([
      'RATE_LIMIT_WINDOW_SECONDS',
      'RATE_LIMIT_CREATE_MAX',
      'RATE_LIMIT_REDIRECT_MAX',
      'RATE_LIMIT_READ_MAX',
    ])('throws on invalid %s', (name) => {
      for (const bad of ['abc', '0', '-1', '1.5']) {
        expect(() => loadConfig({ [name]: bad })).toThrow(name);
      }
    });
  });

  describe('trustProxy', () => {
    it.each([
      [undefined, false],
      ['false', false],
      ['true', true],
      ['1', 1],
      ['2', 2],
      ['10.0.0.1', ['10.0.0.1']],
      ['10.0.0.0/8, 192.168.1.1', ['10.0.0.0/8', '192.168.1.1']],
    ])('TRUST_PROXY=%s -> %j', (value, expected) => {
      const env: Record<string, string> = {};
      if (value !== undefined) {
        env.TRUST_PROXY = value;
      }
      expect(loadConfig(env).trustProxy).toEqual(expected);
    });
  });
});
