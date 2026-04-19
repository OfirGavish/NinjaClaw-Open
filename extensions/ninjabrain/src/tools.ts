/**
 * NinjaClaw — Custom tool definitions for the Copilot SDK.
 *
 * These tools are registered on the CopilotSession and give the agent
 * access to NinjaBrain, memory, Azure CLI, and other NinjaClaw-specific
 * capabilities. The Copilot CLI already provides file I/O, bash, git,
 * and web tools — we only add what's unique to NinjaClaw.
 */

import { z } from "zod";
import { defineTool } from "@github/copilot-sdk";
import {
  brainSearch,
  brainGet,
  brainPut,
  brainLink,
  brainList,
  brainDelete,
  brainStats,
} from "./brain.js";
import {
  getFactsSummary,
  rememberFacts,
  getProfileSummary,
  logToolExecution,
} from "./memory.js";

// ---------------------------------------------------------------------------
// NinjaBrain Tools
// ---------------------------------------------------------------------------

export const brainSearchTool = defineTool("brain_search", {
  description:
    "Full-text search across NinjaBrain knowledge pages. Returns matching pages ranked by relevance. Use to find known entities, people, projects, or concepts.",
  parameters: z.object({
    query: z.string().describe("Search query"),
    limit: z.number().optional().default(5).describe("Max results (1-20)"),
    type_filter: z
      .string()
      .optional()
      .default("")
      .describe("Filter by entity type: person, company, concept, project, tool"),
  }),
  skipPermission: true,
  handler: async ({ query, limit, type_filter }) => {
    const results = await brainSearch(query, limit, type_filter);
    return results.length > 0
      ? JSON.stringify(results, null, 2)
      : "No matching brain pages found.";
  },
});

export const brainGetTool = defineTool("brain_get", {
  description:
    "Get a specific NinjaBrain page by slug. Returns compiled truth, timeline, and cross-links.",
  parameters: z.object({
    slug: z
      .string()
      .describe("Page slug (e.g. people/ofir-gavish, projects/maester)"),
  }),
  skipPermission: true,
  handler: async ({ slug }) => {
    const page = await brainGet(slug);
    return page ? JSON.stringify(page, null, 2) : `[ERROR] Page not found: ${slug}`;
  },
});

export const brainPutTool = defineTool("brain_put", {
  description:
    "Create or update a NinjaBrain page. Compiled truth is a full rewrite of current understanding. Timeline entries are appended (never deleted).",
  parameters: z.object({
    slug: z
      .string()
      .describe("Page slug (e.g. people/john-doe, projects/ninjaclaw)"),
    title: z.string().describe("Display title"),
    compiled_truth: z
      .string()
      .optional()
      .default("")
      .describe("Current best understanding (full rewrite on update)"),
    timeline_entry: z
      .string()
      .optional()
      .default("")
      .describe("What happened now (appended with date)"),
    entity_type: z
      .string()
      .optional()
      .default("")
      .describe("Entity type: person, company, concept, project, tool"),
  }),
  skipPermission: true,
  handler: async ({ slug, title, compiled_truth, timeline_entry, entity_type }) => {
    const result = await brainPut(slug, title, compiled_truth, timeline_entry, entity_type);
    return `Brain page ${result.action}: ${result.slug}`;
  },
});

export const brainLinkTool = defineTool("brain_link", {
  description:
    "Create a cross-reference link between two NinjaBrain pages.",
  parameters: z.object({
    from_slug: z.string().describe("Source page slug"),
    to_slug: z.string().describe("Target page slug"),
    link_type: z
      .string()
      .optional()
      .default("references")
      .describe("Link type: references, works_at, created, uses, etc."),
  }),
  skipPermission: true,
  handler: async ({ from_slug, to_slug, link_type }) => {
    return await brainLink(from_slug, to_slug, link_type);
  },
});

export const brainListTool = defineTool("brain_list", {
  description: "List NinjaBrain pages, optionally filtered by entity type.",
  parameters: z.object({
    entity_type: z
      .string()
      .optional()
      .default("")
      .describe("Filter: person, company, concept, project, tool"),
    limit: z.number().optional().default(20),
  }),
  skipPermission: true,
  handler: async ({ entity_type, limit }) => {
    const pages = await brainList(entity_type, limit);
    return JSON.stringify(pages, null, 2);
  },
});

export const brainDeleteTool = defineTool("brain_delete", {
  description: "Delete a NinjaBrain page and its links.",
  parameters: z.object({
    slug: z.string().describe("Page slug to delete"),
  }),
  handler: async ({ slug }) => {
    return await brainDelete(slug);
  },
});

export const brainStatsTool = defineTool("brain_stats", {
  description: "Get NinjaBrain statistics — total pages, links, breakdown by type.",
  parameters: z.object({}),
  skipPermission: true,
  handler: async () => {
    const stats = await brainStats();
    return JSON.stringify(stats, null, 2);
  },
});

// ---------------------------------------------------------------------------
// Memory Tools
// ---------------------------------------------------------------------------

export const memoryRecallTool = defineTool("memory_recall", {
  description:
    "Recall facts and profile information about the current user. Use this to personalize responses.",
  parameters: z.object({
    user_id: z.number().describe("User ID"),
  }),
  skipPermission: true,
  handler: async ({ user_id }) => {
    const profile = await getProfileSummary(user_id);
    const facts = await getFactsSummary(user_id);
    return `## User Profile\n${profile}\n\n## Remembered Facts\n${facts || "(none)"}`;
  },
});

export const memoryStoreTool = defineTool("memory_store", {
  description:
    "Store new facts about the user for long-term memory.",
  parameters: z.object({
    user_id: z.number().describe("User ID"),
    facts: z.array(z.string()).describe("Facts to remember"),
  }),
  skipPermission: true,
  handler: async ({ user_id, facts }) => {
    const count = await rememberFacts(user_id, facts);
    return `Stored ${count} new fact(s).`;
  },
});

// ---------------------------------------------------------------------------
// Azure CLI Tool
// ---------------------------------------------------------------------------

export const azureCliTool = defineTool("azure_cli", {
  description:
    "Run an Azure CLI (az) command. The host VM is authenticated. Use for managing Azure resources, querying subscriptions, etc.",
  parameters: z.object({
    command: z
      .string()
      .describe("The az command WITHOUT the 'az' prefix (e.g. 'vm list -g MyRG -o table')"),
    timeout: z.number().optional().default(30).describe("Timeout in seconds"),
  }),
  handler: async ({ command, timeout }) => {
    // Block shell injection
    if (/[;&|`$()]/.test(command)) {
      return "[BLOCKED] Shell metacharacters not allowed in az commands";
    }

    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    try {
      const { stdout, stderr } = await execFileAsync("az", command.split(" "), {
        timeout: Math.min(Math.max(timeout, 5), 120) * 1000,
      });
      let result = stdout;
      if (stderr?.trim()) result += `\n[stderr]\n${stderr}`;
      return result.slice(0, 8000);
    } catch (err: any) {
      return `[ERROR] ${err.message?.slice(0, 500) ?? String(err)}`;
    }
  },
});

// ---------------------------------------------------------------------------
// Export all tools as an array for session creation
// ---------------------------------------------------------------------------

export function getAllTools() {
  return [
    brainSearchTool,
    brainGetTool,
    brainPutTool,
    brainLinkTool,
    brainListTool,
    brainDeleteTool,
    brainStatsTool,
    memoryRecallTool,
    memoryStoreTool,
    azureCliTool,
  ];
}
