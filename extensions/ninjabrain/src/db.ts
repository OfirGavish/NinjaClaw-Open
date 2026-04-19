/**
 * NinjaClaw — SQLite database layer (sql.js / WASM).
 *
 * Wraps sql.js with WAL-like behavior and provides the same
 * schema as the Python NinjaClaw (brain_pages, brain_fts, etc.).
 */

import initSqlJs, { type Database } from "sql.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

// NinjaBrain database path — configurable via env or defaults to ~/.ninjaclaw/ninjabrain.db
const DATA_DIR = process.env.NINJACLAW_DATA_DIR ?? join(homedir(), ".ninjaclaw");
const DB_PATH = process.env.NINJABRAIN_DB_PATH ?? join(DATA_DIR, "ninjabrain.db");

let _db: Database | null = null;

function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
}

export async function getDb(): Promise<Database> {
  if (_db) return _db;

  ensureDataDir();
  const SQL = await initSqlJs();

  if (existsSync(DB_PATH)) {
    const buf = readFileSync(DB_PATH);
    _db = new SQL.Database(buf);
  } else {
    _db = new SQL.Database();
  }

  return _db;
}

/** Persist the in-memory database to disk. */
export function saveDb(): void {
  if (!_db) return;
  ensureDataDir();
  const data = _db.export();
  writeFileSync(DB_PATH, Buffer.from(data));
}

/** Run a query and return all rows as plain objects. */
export function allRows(db: Database, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const stmt = db.prepare(sql);
  stmt.bind(params as any);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as Record<string, unknown>);
  }
  stmt.free();
  return rows;
}

/** Run a query and return the first row, or null. */
export function firstRow(db: Database, sql: string, params: unknown[] = []): Record<string, unknown> | null {
  const rows = allRows(db, sql, params);
  return rows[0] ?? null;
}

/** Initialize schema (tables, indexes, FTS5, triggers). */
export async function initSchema(): Promise<void> {
  const db = await getDb();

  db.run(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id INTEGER PRIMARY KEY,
      name TEXT,
      data TEXT DEFAULT '{}',
      created_at REAL,
      updated_at REAL
    );

    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      fact TEXT NOT NULL,
      created_at REAL,
      UNIQUE(user_id, fact)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_facts_user ON facts(user_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      arguments TEXT NOT NULL,
      result_summary TEXT,
      status TEXT NOT NULL DEFAULT 'executed',
      timestamp REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, timestamp);

    -- NinjaBrain: structured knowledge pages
    CREATE TABLE IF NOT EXISTS brain_pages (
      slug TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'concept',
      title TEXT NOT NULL,
      compiled_truth TEXT NOT NULL DEFAULT '',
      timeline TEXT NOT NULL DEFAULT '',
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_brain_type ON brain_pages(type);

    -- NinjaBrain: cross-reference links
    CREATE TABLE IF NOT EXISTS brain_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_slug TEXT NOT NULL,
      to_slug TEXT NOT NULL,
      link_type TEXT NOT NULL DEFAULT 'references',
      created_at REAL NOT NULL,
      UNIQUE(from_slug, to_slug, link_type),
      FOREIGN KEY (from_slug) REFERENCES brain_pages(slug) ON DELETE CASCADE,
      FOREIGN KEY (to_slug) REFERENCES brain_pages(slug) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_brain_links_from ON brain_links(from_slug);
    CREATE INDEX IF NOT EXISTS idx_brain_links_to ON brain_links(to_slug);
  `);

  // FTS5 virtual table (sql.js supports FTS5)
  try {
    db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS brain_fts USING fts5(
        slug, title, compiled_truth, timeline,
        content=brain_pages,
        content_rowid=rowid
      )
    `);
    db.run(`
      CREATE TRIGGER IF NOT EXISTS brain_fts_insert AFTER INSERT ON brain_pages BEGIN
        INSERT INTO brain_fts(rowid, slug, title, compiled_truth, timeline)
        VALUES (new.rowid, new.slug, new.title, new.compiled_truth, new.timeline);
      END
    `);
    db.run(`
      CREATE TRIGGER IF NOT EXISTS brain_fts_update AFTER UPDATE ON brain_pages BEGIN
        INSERT INTO brain_fts(brain_fts, rowid, slug, title, compiled_truth, timeline)
        VALUES ('delete', old.rowid, old.slug, old.title, old.compiled_truth, old.timeline);
        INSERT INTO brain_fts(rowid, slug, title, compiled_truth, timeline)
        VALUES (new.rowid, new.slug, new.title, new.compiled_truth, new.timeline);
      END
    `);
    db.run(`
      CREATE TRIGGER IF NOT EXISTS brain_fts_delete AFTER DELETE ON brain_pages BEGIN
        INSERT INTO brain_fts(brain_fts, rowid, slug, title, compiled_truth, timeline)
        VALUES ('delete', old.rowid, old.slug, old.title, old.compiled_truth, old.timeline);
      END
    `);
  } catch {
    // FTS table already exists
  }

  saveDb();
}
