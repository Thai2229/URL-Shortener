import http from 'k6/http';
import { check } from 'k6';

// Steady GETs of one link through nginx while scaleout.sh kills a replica. Counts non-302 responses.
const URL = __ENV.TARGET_URL;
const RATE = Number(__ENV.RATE || 300);

export const options = {
  scenarios: {
    kill: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '12s',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
};

export default function () {
  const res = http.get(URL, {
    redirects: 0,
    responseCallback: http.expectedStatuses(302),
  });
  check(res, { redirected: (r) => r.status === 302 });
}
