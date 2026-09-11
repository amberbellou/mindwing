-- Mindwing API schema (Cloudflare D1 / SQLite)
-- No personal data is stored: client_id is a random id the browser generates,
-- IP addresses are only used as a salted daily hash for rate limiting.

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  client_id    TEXT,
  created_at   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  start_level  INTEGER NOT NULL DEFAULT 1,
  input        TEXT NOT NULL DEFAULT 'unknown',
  event_count  INTEGER NOT NULL DEFAULT 0,
  max_level    INTEGER NOT NULL DEFAULT 1,
  won          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_client ON sessions(client_id);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  type        TEXT NOT NULL,
  level       INTEGER,
  n           INTEGER,
  v           INTEGER,
  w           INTEGER,
  client_t    INTEGER NOT NULL DEFAULT 0,
  server_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type_level ON events(type, level);

CREATE TABLE IF NOT EXISTS scores (
  session_id  TEXT PRIMARY KEY,
  initials    TEXT NOT NULL,
  score       INTEGER NOT NULL,
  level       INTEGER NOT NULL,
  won         INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_score ON scores(score DESC, updated_at ASC);

CREATE TABLE IF NOT EXISTS rate_limits (
  k       TEXT NOT NULL,
  bucket  INTEGER NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (k, bucket)
);
