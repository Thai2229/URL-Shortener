import type pg from 'pg';

export interface Link {
  id: string;
  code: string;
  targetUrl: string;
  createdAt: Date;
  expiresAt: Date | null;
  clickCount: number;
}

export interface NewLink {
  code: string;
  targetUrl: string;
  expiresAt?: Date | null;
}

interface LinkRow {
  id: string;
  code: string;
  target_url: string;
  created_at: Date;
  expires_at: Date | null;
  click_count: string;
}

const COLUMNS = 'id, code, target_url, created_at, expires_at, click_count';

function toLink(row: LinkRow): Link {
  return {
    id: row.id,
    code: row.code,
    targetUrl: row.target_url,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    clickCount: Number(row.click_count),
  };
}

export async function insertLink(
  db: pg.Pool,
  link: NewLink,
): Promise<Link | null> {
  const { rows } = await db.query<LinkRow>(
    `INSERT INTO links (code, target_url, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (code) DO NOTHING
     RETURNING ${COLUMNS}`,
    [link.code, link.targetUrl, link.expiresAt ?? null],
  );
  if (!rows[0]) {
    return null;
  }
  return toLink(rows[0]);
}

export async function findLinkByCode(
  db: pg.Pool,
  code: string,
): Promise<Link | null> {
  const { rows } = await db.query<LinkRow>(
    `SELECT ${COLUMNS} FROM links WHERE code = $1`,
    [code],
  );
  if (!rows[0]) {
    return null;
  }
  return toLink(rows[0]);
}
