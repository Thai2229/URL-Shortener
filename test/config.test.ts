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
});
