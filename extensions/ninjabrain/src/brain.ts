/**
 * NinjaBrain — Structured knowledge engine.
 *
 * Compiled truth + timeline model. SQLite FTS5 for search.
 * Entity types: person, company, concept, project, tool, other
 * Slug format: type/name (e.g. people/ofir-gavish, companies/microsoft)
 */

import { getDb, allRows, firstRow, saveDb } from "./db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeSlug(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9/_-]/g, "");
}

function typeFromSlug(slug: string): string {
  const prefix = slug.split("/")[0];
  const map: Record<string, string> = {
    people: "person",
    companies: "company",
    concepts: "concept",
    projects: "project",
    tools: "tool",
  };
  return map[prefix] ?? "other";
}

function dateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

export interface BrainPage {
  slug: string;
  type: string;
  title: string;
  compiled_truth: string;
  timeline: string;
  updated_at: number;
  created_at?: number;
  links_to?: { slug: string; type: string }[];
  links_from?: { slug: string; type: string }[];
}

export async function brainSearch(
  query: string,
  limit = 5,
  typeFilter = "",
): Promise<BrainPage[]> {
  const db = await getDb();
  limit = Math.min(Math.max(limit, 1), 20);

  const sql = typeFilter
    ? `SELECT p.slug, p.type, p.title, p.compiled_truth, p.timeline, p.updated_at, rank
       FROM brain_fts f JOIN brain_pages p ON f.slug = p.slug
       WHERE brain_fts MATCH ? AND p.type = ? ORDER BY rank LIMIT ?`
    : `SELECT p.slug, p.type, p.title, p.compiled_truth, p.timeline, p.updated_at, rank
       FROM brain_fts f JOIN brain_pages p ON f.slug = p.slug
       WHERE brain_fts MATCH ? ORDER BY rank LIMIT ?`;

  const params = typeFilter ? [query, typeFilter, limit] : [query, limit];
  return allRows(db, sql, params) as unknown as BrainPage[];
}

export async function brainGet(slug: string): Promise<BrainPage | null> {
  const db = await getDb();
  const row = firstRow(db, "SELECT * FROM brain_pages WHERE slug = ?", [slug]);
  if (!row) return null;

  const linksOut = allRows(
    db,
    "SELECT to_slug, link_type FROM brain_links WHERE from_slug = ?",
    [slug],
  );
  const linksIn = allRows(
    db,
    "SELECT from_slug, link_type FROM brain_links WHERE to_slug = ?",
    [slug],
  );

  return {
    ...(row as unknown as BrainPage),
    links_to: linksOut.map((l) => ({
      slug: l.to_slug as string,
      type: l.link_type as string,
    })),
    links_from: linksIn.map((l) => ({
      slug: l.from_slug as string,
      type: l.link_type as string,
    })),
  };
}

export async function brainPut(
  slug: string,
  title: string,
  compiledTruth = "",
  timelineEntry = "",
  entityType = "",
): Promise<{ slug: string; action: string }> {
  slug = normalizeSlug(slug);
  if (!entityType) entityType = typeFromSlug(slug);
  const now = Date.now() / 1000;
  const db = await getDb();

  const existing = firstRow(db, "SELECT * FROM brain_pages WHERE slug = ?", [
    slug,
  ]);

  if (existing) {
    const newTruth = compiledTruth || (existing.compiled_truth as string);
    let newTimeline = existing.timeline as string;
    if (timelineEntry) {
      newTimeline = `${newTimeline}\n- ${dateStr()}: ${timelineEntry}`.trim();
    }
    db.run(
      "UPDATE brain_pages SET title=?, compiled_truth=?, timeline=?, updated_at=? WHERE slug=?",
      [title || (existing.title as string), newTruth, newTimeline, now, slug],
    );
    saveDb();
    return { slug, action: "updated" };
  }

  const timeline = timelineEntry ? `- ${dateStr()}: ${timelineEntry}` : "";
  db.run(
    `INSERT INTO brain_pages (slug, type, title, compiled_truth, timeline, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [slug, entityType, title, compiledTruth, timeline, now, now],
  );
  saveDb();
  return { slug, action: "created" };
}

export async function brainLink(
  fromSlug: string,
  toSlug: string,
  linkType = "references",
): Promise<string> {
  fromSlug = normalizeSlug(fromSlug);
  toSlug = normalizeSlug(toSlug);
  const db = await getDb();

  for (const s of [fromSlug, toSlug]) {
    if (!firstRow(db, "SELECT 1 FROM brain_pages WHERE slug = ?", [s])) {
      return `[ERROR] Page not found: ${s}`;
    }
  }

  try {
    db.run(
      `INSERT INTO brain_links (from_slug, to_slug, link_type, created_at)
       VALUES (?, ?, ?, ?)`,
      [fromSlug, toSlug, linkType, Date.now() / 1000],
    );
    saveDb();
    return `Linked ${fromSlug} → ${toSlug} (${linkType})`;
  } catch {
    return `Link already exists: ${fromSlug} → ${toSlug} (${linkType})`;
  }
}

export async function brainList(
  entityType = "",
  limit = 20,
): Promise<BrainPage[]> {
  const db = await getDb();
  limit = Math.min(Math.max(limit, 1), 100);

  const sql = entityType
    ? "SELECT slug, type, title, updated_at FROM brain_pages WHERE type = ? ORDER BY updated_at DESC LIMIT ?"
    : "SELECT slug, type, title, updated_at FROM brain_pages ORDER BY updated_at DESC LIMIT ?";

  const params = entityType ? [entityType, limit] : [limit];
  return allRows(db, sql, params) as unknown as BrainPage[];
}

export async function brainDelete(slug: string): Promise<string> {
  const db = await getDb();
  if (!firstRow(db, "SELECT 1 FROM brain_pages WHERE slug = ?", [slug])) {
    return `[ERROR] Page not found: ${slug}`;
  }
  db.run(
    "DELETE FROM brain_links WHERE from_slug = ? OR to_slug = ?",
    [slug, slug],
  );
  db.run("DELETE FROM brain_pages WHERE slug = ?", [slug]);
  saveDb();
  return `Deleted ${slug}`;
}

export async function brainStats(): Promise<{
  total_pages: number;
  total_links: number;
  by_type: Record<string, number>;
}> {
  const db = await getDb();
  const total = (firstRow(db, "SELECT COUNT(*) as c FROM brain_pages")?.c ??
    0) as number;
  const links = (firstRow(db, "SELECT COUNT(*) as c FROM brain_links")?.c ??
    0) as number;
  const byType = allRows(
    db,
    "SELECT type, COUNT(*) as c FROM brain_pages GROUP BY type ORDER BY c DESC",
  );

  return {
    total_pages: total,
    total_links: links,
    by_type: Object.fromEntries(
      byType.map((r) => [r.type as string, r.c as number]),
    ),
  };
}

/**
 * Search brain for entities mentioned in user text.
 * Returns context string to inject into system prompt.
 */
export async function brainContextForMessage(
  userText: string,
): Promise<string> {
  if (!userText || userText.length < 3) return "";

  // Extract potential entity mentions (capitalized words, known patterns)
  const words = userText.match(/[A-Z][a-z]+(?:\s[A-Z][a-z]+)*/g) ?? [];
  const queries = [...new Set(words)].slice(0, 3);

  if (queries.length === 0) {
    // Fallback: search with the full message
    try {
      const results = await brainSearch(userText.slice(0, 100), 3);
      if (results.length === 0) return "";
      return formatBrainContext(results);
    } catch {
      return "";
    }
  }

  const allResults: BrainPage[] = [];
  for (const q of queries) {
    try {
      const results = await brainSearch(q, 2);
      allResults.push(...results);
    } catch {
      // FTS query syntax error — skip
    }
  }

  const unique = [
    ...new Map(allResults.map((r) => [r.slug, r])).values(),
  ].slice(0, 5);
  if (unique.length === 0) return "";
  return formatBrainContext(unique);
}

function formatBrainContext(pages: BrainPage[]): string {
  const parts = ["## NinjaBrain Context (auto-injected)\n"];
  for (const p of pages) {
    parts.push(`### ${p.title} (${p.type}: ${p.slug})`);
    if (p.compiled_truth) parts.push(p.compiled_truth);
    if (p.timeline) parts.push(`Timeline:\n${p.timeline}`);
    parts.push("");
  }
  return parts.join("\n");
}
