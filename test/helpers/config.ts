import { loadConfig } from '../../src/config.js';

// Test config with rate limiting off so suites sharing one client IP stay independent.
export function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({ RATE_LIMIT_ENABLED: 'false', ...overrides });
}
