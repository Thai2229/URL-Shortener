import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, createLink, summarize, TREND_STATS } from './lib.js';

export const options = {
  vus: 1,
  iterations: 20,
  summaryTrendStats: TREND_STATS,
  thresholds: {
    http_req_failed: ['rate==0'],
    checks: ['rate==1'],
    http_req_duration: ['p(95)<200'],
  },
};

function get(path, name, statuses) {
  return http.get(`${BASE_URL}${path}`, {
    redirects: 0,
    tags: { name },
    responseCallback: http.expectedStatuses(...statuses),
  });
}

export default function () {
  const target = `https://example.com/smoke/${__VU}/${__ITER}/${Date.now()}`;
  const created = createLink(target, [201]);
  check(created, { 'create 201': (r) => r.status === 201 });
  const code = created.json('code');

  const redirected = get(`/${code}`, 'redirect', [302]);
  check(redirected, {
    'redirect 302': (r) => r.status === 302,
    'redirect Location': (r) => r.headers['Location'] === target,
  });

  const meta = get(`/api/links/${code}`, 'metadata', [200]);
  check(meta, {
    'metadata 200': (r) => r.status === 200,
    'metadata url': (r) => r.json('url') === target,
  });

  check(get('/zzzzzzzz-unknown', 'unknown', [404]), {
    'unknown 404': (r) => r.status === 404,
  });
  check(get('/healthz', 'healthz', [200]), {
    'healthz 200': (r) => r.status === 200,
  });
  check(get('/readyz', 'readyz', [200]), {
    'readyz 200': (r) => r.status === 200,
  });
}

export function handleSummary(data) {
  return summarize('smoke', data);
}
