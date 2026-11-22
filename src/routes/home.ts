import { readFileSync } from 'node:fs';
import type { FastifyPluginAsync } from 'fastify';

// ../../public works from src/routes (tsx/vitest) and dist/routes (built).
const PUBLIC_DIR = new URL('../../public/', import.meta.url);

const ASSETS = [
  { route: '/', file: 'index.html', type: 'text/html; charset=utf-8' },
  { route: '/app.js', file: 'app.js', type: 'text/javascript; charset=utf-8' },
  { route: '/styles.css', file: 'styles.css', type: 'text/css; charset=utf-8' },
  { route: '/favicon.svg', file: 'favicon.svg', type: 'image/svg+xml' },
];

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function load(file: string) {
  try {
    return readFileSync(new URL(file, PUBLIC_DIR));
  } catch (err) {
    throw new Error(
      `Cannot read public/${file} (${PUBLIC_DIR.pathname}): ${String(err)}`,
    );
  }
}

export const homeRoutes: FastifyPluginAsync = async (app) => {
  const loaded = ASSETS.map((asset) => ({ ...asset, body: load(asset.file) }));
  for (const { route, type, body } of loaded) {
    app.get(route, async (_request, reply) =>
      reply
        .header('content-type', type)
        .header('content-security-policy', CSP)
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        .header('x-frame-options', 'DENY')
        .header('cache-control', 'public, max-age=300')
        .send(body),
    );
  }
};
