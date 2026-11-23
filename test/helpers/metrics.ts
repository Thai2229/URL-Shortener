export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

// Tiny Prometheus text-format parser: skips comments, handles quoted/escaped label values.
export function parseMetrics(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const match =
      /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(\S+)(\s+\S+)?$/.exec(line);
    if (!match) {
      throw new Error(`unparseable metrics line: ${line}`);
    }
    const labels: Record<string, string> = {};
    const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
    for (const m of (match[3] ?? '').matchAll(re)) {
      const [, key = '', val = ''] = m;
      labels[key] = val.replace(/\\(.)/g, (_s, c) => {
        if (c === 'n') {
          return '\n';
        }
        return c;
      });
    }
    const raw = match[4];
    let value = Number(raw);
    if (raw === '+Inf') {
      value = Infinity;
    }
    samples.push({ name: match[1] ?? '', labels, value });
  }
  return samples;
}

// Samples with this name whose labels include every given label.
export function select(
  samples: Sample[],
  name: string,
  labels: Record<string, string> = {},
) {
  return samples.filter(
    (s) =>
      s.name === name &&
      Object.entries(labels).every(([k, v]) => s.labels[k] === v),
  );
}

// Value of the single matching sample, 0 when the series does not exist yet.
export function valueOf(
  samples: Sample[],
  name: string,
  labels: Record<string, string> = {},
) {
  const found = select(samples, name, labels);
  if (found.length > 1) {
    throw new Error(
      `${name} ${JSON.stringify(labels)} matched ${found.length}`,
    );
  }
  return found[0]?.value ?? 0;
}
