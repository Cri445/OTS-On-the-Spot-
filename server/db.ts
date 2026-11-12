import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  avatar_color TEXT NOT NULL,
  legal_name TEXT,
  birth_date TEXT,
  id_verified_at TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  host_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  vibe TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  -- Slightly shifted coordinates shown to people who haven't joined a hide_exact activity.
  public_lat REAL NOT NULL,
  public_lng REAL NOT NULL,
  address TEXT NOT NULL,
  hide_exact INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  security TEXT NOT NULL DEFAULT 'open',
  featured INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  cancelled_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activities_upcoming ON activities(status, ends_at);
CREATE INDEX IF NOT EXISTS activities_host ON activities(host_id);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY,
  activity_id INTEGER NOT NULL REFERENCES activities(id),
  leader_id INTEGER NOT NULL REFERENCES users(id),
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'open',
  pay_mode TEXT,
  hold_expires_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS groups_activity ON groups(activity_id, status);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  activity_id INTEGER REFERENCES activities(id),
  group_id INTEGER REFERENCES groups(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_group ON payments(group_id);

CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  payment_id INTEGER REFERENCES payments(id),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_user ON group_members(user_id);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  activity_id INTEGER NOT NULL REFERENCES activities(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  group_id INTEGER REFERENCES groups(id),
  payment_id INTEGER REFERENCES payments(id),
  code TEXT NOT NULL UNIQUE,
  price_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  checked_in_at TEXT,
  created_at TEXT NOT NULL,
  cancelled_at TEXT
);
-- One live ticket per person per activity.
CREATE UNIQUE INDEX IF NOT EXISTS tickets_one_live ON tickets(activity_id, user_id) WHERE status IN ('pending', 'active');
CREATE INDEX IF NOT EXISTS tickets_user ON tickets(user_id);

-- Every movement of money. user_id NULL means the platform (OTS) itself.
-- affects_balance = 1 rows make up a host's payout balance; the rest are card
-- charges and refunds, kept so people can see their history.
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  affects_balance INTEGER NOT NULL DEFAULT 0,
  activity_id INTEGER REFERENCES activities(id),
  ticket_id INTEGER REFERENCES tickets(id),
  memo TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id, id);
`;

/*
 * Changes to the schema above go here, one entry per release, and are applied
 * in order to databases created by an earlier version. Never edit an entry
 * that has shipped — add a new one.
 */
const MIGRATIONS: string[] = [
  // 2: profile pictures, venue photos, age limits, two-step login
  `
  ALTER TABLE users ADD COLUMN avatar_image TEXT;
  ALTER TABLE users ADD COLUMN totp_secret TEXT;
  ALTER TABLE users ADD COLUMN totp_pending TEXT;
  ALTER TABLE users ADD COLUMN totp_enabled_at TEXT;
  ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE activities ADD COLUMN photos TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE activities ADD COLUMN min_age INTEGER;

  CREATE TABLE images (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL,
    mime TEXT NOT NULL,
    bytes BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX images_owner ON images(owner_id, kind);

  CREATE TABLE recovery_codes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    PRIMARY KEY (user_id, code_hash)
  );

  -- A password that checked out, waiting for the second step of a two-step login.
  CREATE TABLE login_challenges (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL
  );
  `,
];

export interface RunResult {
  changes: number;
  lastId: number;
}

/** A thin, synchronous wrapper over Node's built-in SQLite. */
export const BASE_SCHEMA = SCHEMA;

export class Db {
  private readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.raw.exec(SCHEMA);
    this.migrate();
  }

  /** Bring an older database up to date. The base schema above is version 1. */
  private migrate(): void {
    const row = this.raw.prepare('PRAGMA user_version').get() as { user_version: number };
    let version = Math.max(1, Number(row.user_version));
    while (version <= MIGRATIONS.length) {
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        this.raw.exec(MIGRATIONS[version - 1]);
        this.raw.exec(`PRAGMA user_version = ${version + 1}`);
        this.raw.exec('COMMIT');
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
      version++;
    }
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]): RunResult {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  }

  /**
   * Run `fn` atomically. Because the driver is synchronous, nothing else can
   * touch the database while `fn` runs — as long as `fn` never awaits.
   */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}
