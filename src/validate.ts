const MAX_URL_LENGTH = 2048;

// Returns the normalized href, or null when the url is not acceptable.
export function validateUrl(input: string, baseUrl: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length > MAX_URL_LENGTH || !URL.canParse(trimmed)) {
    return null;
  }
  const url = new URL(trimmed);
  const ownHost = new URL(baseUrl).host.toLowerCase();
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.host.toLowerCase() === ownHost
  ) {
    return null;
  }
  return url.href;
}

export function validateExpiry(input: unknown): Date | null {
  if (typeof input !== 'string') {
    return null;
  }
  const date = new Date(input);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
    return null;
  }
  return date;
}
