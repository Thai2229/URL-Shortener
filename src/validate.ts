const MAX_URL_LENGTH = 2048;

// Returns the normalized href, or null when the url is not acceptable.
export function validateUrl(input: string, baseUrl: string): string | null {
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
    (hostOf(url) === hostOf(own) && portOf(url) === portOf(own))
  ) {
    return null;
  }
  return url.href;
}

function hostOf(url: URL): string {
  return url.hostname.replace(/\.+$/, '').toLowerCase();
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
