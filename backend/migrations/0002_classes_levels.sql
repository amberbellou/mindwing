-- Classrooms, game build, and difficulty.
-- A class is created by a teacher with no account: they get a public code for students and a private key
-- for their dashboard. Only a SHA-256 hash of the key is stored. The label is whatever the teacher types
-- (for example "Period 3"); the teacher page asks them not to use student names.

CREATE TABLE IF NOT EXISTS classes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  key_hash    TEXT NOT NULL,
  label       TEXT,
  created_at  INTEGER NOT NULL
);

-- class_id: the class a run was played in, if any.
-- build: which layout of the game produced the run. NULL means the original 4-level game, where the boss was
-- level 4; runs from the 5-level game (hallucination at level 4, boss at level 5) carry a build string.
-- difficulty: easy | normal | hard, as chosen in Settings.
ALTER TABLE sessions ADD COLUMN class_id INTEGER;
ALTER TABLE sessions ADD COLUMN build TEXT;
ALTER TABLE sessions ADD COLUMN difficulty TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_class ON sessions(class_id, created_at);
