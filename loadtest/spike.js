import { check } from 'k6';
import { RATE, redirect, summarize, TREND_STATS } from './lib.js';

const LOW = Math.max(1, Math.floor(RATE / 4));

export const options = {
  summaryTrendStats: TREND_STATS,
  scenarios: {
    spike: {
      executor: 'ramping-arrival-rate',
      startRate: LOW,
      timeUnit: '1s',
      preAllocatedVUs: Math.max(100, Math.ceil(RATE / 5)),
      maxVUs: Math.max(600, RATE),
      stages: [
        { target: LOW, duration: '10s' },
        { target: RATE * 3, duration: '10s' },
        { target: RATE * 3, duration: '10s' },
        { target: LOW, duration: '10s' },
        { target: LOW, duration: '10s' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    'http_req_duration{expected_response:true}': ['p(95)<200'],
    checks: ['rate>0.98'],
  },
};

export default function () {
  const { res, expected } = redirect();
  check(res, { 'expected status': (r) => r.status === expected });
}

export function handleSummary(data) {
  return summarize('spike', data);
}
