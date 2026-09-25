-- Latest pulled data per source (meta, web, floco), shared by every user.
CREATE TABLE IF NOT EXISTS snapshots (
  key TEXT PRIMARY KEY,
  data TEXT,
  fetched_at INTEGER,
  attempted_at INTEGER,
  error TEXT
);

-- Who may sign in, and what they may see. role: owner = everything, team = no P&L or ad controls.
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('owner', 'team')),
  name TEXT,
  added_at INTEGER NOT NULL,
  code_hash TEXT,
  code_salt TEXT
);

-- Signed-in phones. Only a hash of each session token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_email ON sessions (email);

-- Failed sign-in counters, per network address and per email, for lockout.
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

-- Access keys for Meta and Wix (META_TOKEN, WIX_API_KEY, ADLIB_TOKEN). Never sent to phones.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  budget REAL,
  budget_text TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL CHECK (stage IN ('contacted', 'qualified', 'won', 'lost')),
  notes TEXT NOT NULL DEFAULT '',
  appt_day INTEGER,
  appt_time TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  date TEXT NOT NULL,
  total REAL NOT NULL DEFAULT 0,
  labor REAL NOT NULL DEFAULT 0,
  materials REAL NOT NULL DEFAULT 0,
  transportation REAL NOT NULL DEFAULT 0,
  utilities REAL NOT NULL DEFAULT 0,
  other REAL NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL DEFAULT ''
);

-- Change counters so phones know when leads or jobs changed without re-downloading them.
CREATE TABLE IF NOT EXISTS revisions (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO revisions (key, value) VALUES ('leads', 1), ('jobs', 1);
