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
      clickFlushIntervalSeconds: 5,
      metricsEnabled: true,
      metricsToken: undefined,
      cronSecret: undefined,
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

    it.each([
      'false',
      'False',
      'FALSE',
      '0',
      'off',
      'OFF',
      'no',
      'No',
      ' false ',
    ])('disables with RATE_LIMIT_ENABLED=%j', (v) => {
      expect(loadConfig({ RATE_LIMIT_ENABLED: v }).rateLimit.enabled).toBe(
        false,
      );
    });

    it.each(['true', 'True', 'TRUE', '1', 'on', 'ON', 'yes', 'Yes', ' true '])(
      'enables with RATE_LIMIT_ENABLED=%j',
      (v) => {
        expect(loadConfig({ RATE_LIMIT_ENABLED: v }).rateLimit.enabled).toBe(
          true,
        );
      },
    );

    it.each(['maybe', '2', 'disable'])(
      'throws on invalid RATE_LIMIT_ENABLED=%s',
      (v) => {
        expect(() => loadConfig({ RATE_LIMIT_ENABLED: v })).toThrow(
          /RATE_LIMIT_ENABLED/,
        );
      },
    );

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

  describe('clickFlushIntervalSeconds', () => {
    it.each([
      [undefined, 5],
      ['10', 10],
      ['1', 1],
      ['0', 0],
      ['86400', 86400],
    ])('CLICK_FLUSH_INTERVAL_SECONDS=%s -> %j', (value, expected) => {
      const env: Record<string, string> = {};
      if (value !== undefined) {
        env.CLICK_FLUSH_INTERVAL_SECONDS = value;
      }
      expect(loadConfig(env).clickFlushIntervalSeconds).toBe(expected);
    });

    it.each(['abc', '-1', '1.5', '1e400', 'NaN', '86401', '2147484', '1e9'])(
      'throws naming the variable on %j',
      (bad) => {
        expect(() => loadConfig({ CLICK_FLUSH_INTERVAL_SECONDS: bad })).toThrow(
          /CLICK_FLUSH_INTERVAL_SECONDS/,
        );
      },
    );
  });

  describe('metrics', () => {
    it.each(['false', 'False', '0', 'off', 'OFF', 'no', ' false '])(
      'disables with METRICS_ENABLED=%j',
      (v) => {
        expect(loadConfig({ METRICS_ENABLED: v }).metricsEnabled).toBe(false);
      },
    );

    it.each(['true', 'True', '1', 'on', 'yes', ' true ', ''])(
      'enables with METRICS_ENABLED=%j',
      (v) => {
        expect(loadConfig({ METRICS_ENABLED: v }).metricsEnabled).toBe(true);
      },
    );

    it.each(['maybe', '2', 'disable'])(
      'throws naming METRICS_ENABLED on %s',
      (v) => {
        expect(() => loadConfig({ METRICS_ENABLED: v })).toThrow(
          /METRICS_ENABLED/,
        );
      },
    );

    it('does not mix up with RATE_LIMIT_ENABLED', () => {
      const c = loadConfig({ RATE_LIMIT_ENABLED: 'false' });
      expect(c.metricsEnabled).toBe(true);
      expect(c.rateLimit.enabled).toBe(false);
    });

    it('reads METRICS_TOKEN', () => {
      const token = 'a'.repeat(16);
      expect(loadConfig({ METRICS_TOKEN: token }).metricsToken).toBe(token);
      expect(
        loadConfig({ METRICS_TOKEN: 'long-enough-token-value-123' })
          .metricsToken,
      ).toBe('long-enough-token-value-123');
    });

    it('treats an empty or missing METRICS_TOKEN as undefined', () => {
      expect(loadConfig({ METRICS_TOKEN: '' }).metricsToken).toBeUndefined();
      expect(loadConfig({}).metricsToken).toBeUndefined();
    });

    it('throws naming METRICS_TOKEN when shorter than 16 characters', () => {
      expect(() => loadConfig({ METRICS_TOKEN: 'a'.repeat(15) })).toThrow(
        /METRICS_TOKEN/,
      );
      expect(() => loadConfig({ METRICS_TOKEN: 'x' })).toThrow(/METRICS_TOKEN/);
    });
  });
});
