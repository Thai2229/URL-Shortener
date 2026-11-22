CREATE TABLE links (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The UNIQUE index is the redirect hot path (lookup by code).
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9_-]{1,32}$'),
  target_url  text NOT NULL CHECK (length(target_url) <= 2048),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NULL,
  click_count bigint NOT NULL DEFAULT 0
) WITH (fillfactor = 80);
-- fillfactor 80: click_count is updated in batches and is not indexed, so
-- leaving 20% free space per page lets those updates be HOT (no index writes, cheap vacuum).
