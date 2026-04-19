/**
 * NinjaClaw — Persistent memory (profiles, facts, conversations, audit).
 */

import { getDb, allRows, firstRow, saveDb } from "./db.js";

// ---------------------------------------------------------------------------
// User Profiles
// ---------------------------------------------------------------------------

export async function getOrCreateProfile(
  userId: number,
  name = "",
): Promise<{ user_id: number; name: string; data: Record<string, string> }> {
  const db = await getDb();
  const row = firstRow(db, "SELECT * FROM user_profiles WHERE user_id = ?", [
    userId,
  ]);
  if (row) {
    return {
      user_id: row.user_id as number,
      name: row.name as string,
      data: JSON.parse((row.data as string) || "{}"),
    };
  }

  const now = Date.now() / 1000;
  db.run(
    "INSERT INTO user_profiles (user_id, name, data, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
    [userId, name, now, now],
  );
  saveDb();
  return { user_id: userId, name, data: {} };
}

export async function updateProfileBulk(
  userId: number,
  fields: Record<string, string>,
): Promise<void> {
  const db = await getDb();
  const row = firstRow(db, "SELECT data FROM user_profiles WHERE user_id = ?", [
    userId,
  ]);
  if (row) {
    const data = { ...JSON.parse((row.data as string) || "{}"), ...fields };
    db.run(
      "UPDATE user_profiles SET data = ?, updated_at = ? WHERE user_id = ?",
      [JSON.stringify(data), Date.now() / 1000, userId],
    );
    saveDb();
  }
}

export async function getProfileSummary(userId: number): Promise<string> {
  const profile = await getOrCreateProfile(userId);
  const parts = [`Name: ${profile.name}`];
  for (const [k, v] of Object.entries(profile.data)) {
    parts.push(`${k}: ${v}`);
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Facts / Memory
// ---------------------------------------------------------------------------

export async function rememberFact(
  userId: number,
  fact: string,
): Promise<boolean> {
  const db = await getDb();
  try {
    db.run(
      "INSERT INTO facts (user_id, fact, created_at) VALUES (?, ?, ?)",
      [userId, fact.trim(), Date.now() / 1000],
    );
    saveDb();
    return true;
  } catch {
    return false; // Already exists (UNIQUE constraint)
  }
}

export async function rememberFacts(
  userId: number,
  facts: string[],
): Promise<number> {
  let count = 0;
  for (const fact of facts) {
    if (fact.trim() && (await rememberFact(userId, fact.trim()))) count++;
  }
  return count;
}

export async function getFacts(
  userId: number,
): Promise<{ id: number; fact: string }[]> {
  const db = await getDb();
  return allRows(
    db,
    "SELECT id, fact FROM facts WHERE user_id = ? ORDER BY created_at",
    [userId],
  ) as unknown as { id: number; fact: string }[];
}

export async function getFactsSummary(userId: number): Promise<string> {
  const facts = await getFacts(userId);
  if (facts.length === 0) return "";
  return facts.map((f) => `- ${f.fact}`).join("\n");
}

// ---------------------------------------------------------------------------
// Conversation History
// ---------------------------------------------------------------------------

export async function saveMessage(
  userId: number,
  role: string,
  content: string,
): Promise<void> {
  const db = await getDb();
  db.run(
    "INSERT INTO conversations (user_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
    [userId, role, content, Date.now() / 1000],
  );
  saveDb();
}

export async function getRecentMessages(
  userId: number,
  limit = 30,
): Promise<{ role: string; content: string }[]> {
  const db = await getDb();
  const rows = allRows(
    db,
    "SELECT role, content FROM conversations WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?",
    [userId, limit],
  );
  return (rows as unknown as { role: string; content: string }[]).reverse();
}

// ---------------------------------------------------------------------------
// Audit Log
// ---------------------------------------------------------------------------

export async function logToolExecution(
  userId: number,
  toolName: string,
  args: string,
  resultSummary = "",
  status = "executed",
): Promise<void> {
  const db = await getDb();
  db.run(
    `INSERT INTO audit_log (user_id, tool_name, arguments, result_summary, status, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      userId,
      toolName,
      args.slice(0, 2000),
      resultSummary.slice(0, 500),
      status,
      Date.now() / 1000,
    ],
  );
  saveDb();
}
