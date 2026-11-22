import { check } from 'k6';
import exec from 'k6/execution';
import {
  createLink,
  DURATION,
  RATE,
  redirect,
  summarize,
  TREND_STATS,
} from './lib.js';

export const options = {
  summaryTrendStats: TREND_STATS,
  scenarios: {
    mixed: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(50, Math.ceil(RATE / 20)),
      maxVUs: Math.max(200, Math.ceil(RATE / 5)),
    },
  },
  thresholds: {
    'http_req_failed{name:redirect}': ['rate<0.01'],
    'http_req_failed{name:create}': ['rate<0.01'],
    'http_req_duration{name:redirect,expected_response:true}': [
      'p(95)<50',
      'p(99)<150',
    ],
    'http_req_duration{name:create,expected_response:true}': ['p(95)<150'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  if (Math.random() < 0.05) {
    const url = `https://example.com/mixed/${exec.scenario.iterationInTest}/${Date.now()}`;
    check(createLink(url, [201]), { 'create 201': (r) => r.status === 201 });
    return;
  }
  const { res, expected } = redirect();
  check(res, { 'redirect expected status': (r) => r.status === expected });
}

export function handleSummary(data) {
  return summarize('mixed', data);
}
