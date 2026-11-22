const MAX_URL_LENGTH = 2048;

// Returns the normalized href, or null when the url is not acceptable.
export function validateUrl(
  input: string,
  baseUrl: string,
  allowPrivateTargets = false,
): string | null {
  const trimmed = input.trim();
  if (!URL.canParse(trimmed)) {
    return null;
  }
  const url = new URL(trimmed);
  const own = new URL(baseUrl);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.href.length > MAX_URL_LENGTH ||
    url.username ||
    url.password ||
    (hostOf(url) === hostOf(own) && portOf(url) === portOf(own)) ||
    (!allowPrivateTargets && isPrivateHost(hostOf(url)))
  ) {
    return null;
  }
  return url.href;
}

function hostOf(url: URL): string {
  return url.hostname.replace(/\.+$/, '').toLowerCase();
}

// The URL parser has already normalized numeric hosts, so only canonical forms arrive here.
function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    return isPrivateIPv6(host.slice(1, -1));
  }
  const octets = parseIPv4(host);
  return octets !== null && isPrivateIPv4(octets);
}

function parseIPv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => {
    if (/^\d{1,3}$/.test(part)) {
      return Number(part);
    }
    return NaN;
  });
  if (octets.some((n) => !(n >= 0 && n <= 255))) {
    return null;
  }
  return octets;
}

function isPrivateIPv4(octets: number[]): boolean {
  const [a = 0, b = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

// Eight 16-bit groups from a canonical IPv6 literal (no brackets), or null.
function parseIPv6(literal: string): number[] | null {
  const halves = literal.split('::');
  if (halves.length > 2) {
    return null;
  }
  const groups = (half: string) => {
    if (half === '') {
      return [];
    }
    return half.split(':').map((g) => {
      if (/^[0-9a-f]{1,4}$/.test(g)) {
        return parseInt(g, 16);
      }
      return NaN;
    });
  };
  const head = groups(halves[0] ?? '');
  const tail = groups(halves[1] ?? '');
  const missing = 8 - head.length - tail.length;
  const compressed = halves.length === 2;
  if ((compressed && missing < 1) || (!compressed && missing !== 0)) {
    return null;
  }
  const all = [...head, ...new Array<number>(missing).fill(0), ...tail];
  if (all.some((n) => Number.isNaN(n))) {
    return null;
  }
  return all;
}

function isPrivateIPv6(literal: string): boolean {
  const g = parseIPv6(literal);
  if (g === null) {
    return true;
  }
  const embeddedV4 = [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255];
  const zeros = g.slice(0, 5).every((n) => n === 0);
  return (
    // ::, ::1 and IPv4-compatible (::a.b.c.d) and IPv4-mapped (::ffff:a.b.c.d) forms
    (zeros && (g[5] === 0 || g[5] === 0xffff) && isPrivateIPv4(embeddedV4)) ||
    (g[0]! & 0xfe00) === 0xfc00 ||
    (g[0]! & 0xffc0) === 0xfe80
  );
}

function portOf(url: URL): string {
  if (url.port) {
    return url.port;
  }
  if (url.protocol === 'https:') {
    return '443';
  }
  return '80';
}

const MAX_EXPIRY_MS = 10 * 365.25 * 86_400_000;
const ISO_EXPIRY =
  /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/;

export function validateExpiry(input: unknown): Date | null {
  if (typeof input !== 'string') {
    return null;
  }
  const match = ISO_EXPIRY.exec(input);
  if (!match) {
    return null;
  }
  const calendar = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  const date = new Date(Date.parse(input));
  if (
    calendar.getUTCMonth() !== Number(match[2]) - 1 ||
    calendar.getUTCDate() !== Number(match[3]) ||
    Number.isNaN(date.getTime()) ||
    date.getTime() <= Date.now() ||
    date.getTime() > Date.now() + MAX_EXPIRY_MS
  ) {
    return null;
  }
  return date;
}
