import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import exec from 'k6/execution';
import { createLink, summarize, TREND_STATS } from './lib.js';

const created = new Counter('created_201');
const limited = new Counter('limited_429');
const server5xx = new Rate('server_5xx');

// Create limit defaults to 20/min per IP; 100 req/s for 15s is far above it.
export const options = {
  summaryTrendStats: TREND_STATS,
  scenarios: {
    ratelimit: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 100),
      timeUnit: '1s',
      duration: __ENV.DURATION || '15s',
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
  },
  thresholds: {
    server_5xx: ['rate==0'],
    created_201: ['count>0'],
    limited_429: ['count>0'],
    checks: ['rate==1'],
  },
};

export default function () {
  const url = `https://example.com/rl/${exec.scenario.iterationInTest}/${Date.now()}`;
  const res = createLink(url, [201, 429]);
  server5xx.add(res.status >= 500);
  if (res.status === 201) created.add(1);
  if (res.status === 429) limited.add(1);
  check(res, {
    '201 or 429': (r) => r.status === 201 || r.status === 429,
    '429 has Retry-After': (r) =>
      r.status !== 429 || !!r.headers['Retry-After'],
  });
}

export function handleSummary(data) {
  return summarize('ratelimit', data);
}
