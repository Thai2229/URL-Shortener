import { check } from 'k6';
import { DURATION, RATE, redirect, summarize, TREND_STATS } from './lib.js';

export const options = {
  summaryTrendStats: TREND_STATS,
  scenarios: {
    redirect: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(50, Math.ceil(RATE / 20)),
      maxVUs: Math.max(200, Math.ceil(RATE / 5)),
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{expected_response:true}': ['p(95)<50', 'p(99)<150'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const { res, expected } = redirect();
  check(res, {
    'expected status': (r) => r.status === expected,
    'has Location': (r) => expected === 404 || !!r.headers['Location'],
  });
}

export function handleSummary(data) {
  return summarize('redirect', data);
}
