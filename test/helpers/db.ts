import { randomBytes } from 'node:crypto';
import { afterAll } from 'vitest';
import type pg from 'pg';
import { createPool } from '../../src/db/pool.js';

export const DEFAULT_TEST_DATABASE_URL =
  'postgres://urlshortener:urlshortener@localhost:5432/urlshortener_test';

export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
}

// Creates a pool for the calling test file and closes it in afterAll.
export function usePool(): pg.Pool {
  const pool = createPool(testDatabaseUrl());
  afterAll(() => pool.end());
  return pool;
}

// Unique, valid code (A-Za-z0-9_-, <= 32 chars) so parallel files never collide.
export function uniqueCode(prefix = 't'): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`.slice(0, 32);
}
