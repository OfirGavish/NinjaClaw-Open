/**
 * NinjaBrain — OpenClaw extension entry point.
 *
 * Registers brain tools (search, get, put, link, list, delete, stats)
 * and memory tools (recall, store) with the OpenClaw agent runtime.
 */

export { brainSearch, brainGet, brainPut, brainLink, brainList, brainDelete, brainStats, brainContextForMessage } from "./src/brain.js";
export { getOrCreateProfile, updateProfileBulk, getProfileSummary, rememberFact, rememberFacts, getFacts, getFactsSummary, saveMessage, getRecentMessages, logToolExecution } from "./src/memory.js";
export { initSchema, getDb, saveDb } from "./src/db.js";
