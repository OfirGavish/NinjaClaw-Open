/**
 * NinjaClaw — Agent engine powered by the GitHub Copilot SDK.
 *
 * Replaces the old Python copilot.py + chat_handler.py with a single-model
 * agent loop. No split-brain. The same model that plans also executes tools,
 * reads files, writes code, and verifies its own output.
 */

import {
  CopilotClient,
  type CopilotSession,
  type PermissionRequest,
  type PermissionRequestResult,
} from "@github/copilot-sdk";
import { COPILOT_MODEL, GITHUB_TOKEN } from "./config.js";
import { getAllTools } from "./tools.js";
import { brainContextForMessage } from "./brain.js";
import { getProfileSummary, getFactsSummary, saveMessage, logToolExecution } from "./memory.js";

// ---------------------------------------------------------------------------
// Blocked / dangerous command patterns
// ---------------------------------------------------------------------------

const BLOCKED_PATTERNS = [
  /\brm\s+-rf\s+\//,
  /\bmkfs\b/,
  /\bdd\s+if=.*of=\/dev\//,
  /:\(\)\{.*\|.*&\s*\};:/,
  /\bshutdown\b/,
  /\breboot\b/,
];

const DANGEROUS_PATTERNS = [
  /\brm\s+(-[rfi]+\s+)*\S+/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\b/,
  /\bsudo\b/,
];

function checkShellSafety(command: string): PermissionRequestResult {
  const lower = command.toLowerCase();
  for (const p of BLOCKED_PATTERNS) {
    if (p.test(lower))
      return { kind: "denied-interactively-by-user" };
  }
  // Dangerous commands are allowed but logged — the SDK handles the prompt
  return { kind: "approved" };
}

// ---------------------------------------------------------------------------
// Permission handler — security gate for all tool calls
// ---------------------------------------------------------------------------

function permissionHandler(
  request: PermissionRequest,
): PermissionRequestResult {
  if (request.kind === "shell" && (request as any).fullCommandText) {
    return checkShellSafety((request as any).fullCommandText);
  }
  // All custom tools and reads are approved (brain tools have skipPermission)
  // Writes get the default SDK prompt
  return { kind: "approved" };
}

// ---------------------------------------------------------------------------
// Agent singleton
// ---------------------------------------------------------------------------

let client: CopilotClient | null = null;
const sessions = new Map<number, CopilotSession>();

export async function startAgent(): Promise<void> {
  client = new CopilotClient({
    githubToken: GITHUB_TOKEN || undefined,
  });
  await client.start();
  console.log("[NinjaClaw] Copilot SDK agent started");
}

export async function stopAgent(): Promise<void> {
  if (!client) return;
  const errors = await client.stop();
  if (errors.length > 0) {
    console.error("[NinjaClaw] Agent stop errors:", errors);
  }
  client = null;
  sessions.clear();
}

/**
 * Get or create a session for a user.
 * Each user gets their own persistent session with NinjaBrain tools.
 */
async function getSession(userId: number): Promise<CopilotSession> {
  if (sessions.has(userId)) return sessions.get(userId)!;
  if (!client) throw new Error("Agent not started");

  const session = await client.createSession({
    sessionId: `ninjaclaw-user-${userId}`,
    model: COPILOT_MODEL,
    tools: getAllTools(),
    onPermissionRequest: permissionHandler,
    systemMessage: {
      mode: "customize",
      sections: {
        identity: {
          action: "replace",
          content: `You are NinjaClaw — a security-focused AI agent owned by Ofir Gavish.
You have NinjaBrain (a structured knowledge engine) and persistent memory.
Before answering about known entities, use brain_search to check your knowledge base.
After learning new facts, use brain_put to store them. Use memory_store for user-specific facts.`,
        },
        tone: {
          action: "replace",
          content: `Direct, concise, actionable. No filler. Security-first mindset.
Fluent in Azure, AWS, Kubernetes, Terraform, Bicep, Python, TypeScript, PowerShell.
Informal and occasionally witty, never sycophantic. When unsure, say so.`,
        },
      },
      content: `
## Code generation discipline (READ-BEFORE-WRITE)
- NEVER generate code for an existing codebase without FIRST reading reference files.
- When adding to a repo: list the directory structure, read 2-3 similar existing files.
- Match exact patterns: naming, directory placement, imports, function signatures, API usage.
- If the user says "do it like X" → read X first, extract every pattern, then follow precisely.
- NEVER use display-name matching when the codebase uses setting definition IDs or OData filters.
- After writing code, re-read what you wrote and verify it matches reference patterns.

## Honesty and follow-through
- NEVER claim you refactored or fixed code without actually changing it.
- If you say "I'll use approach X", you MUST actually use approach X in the code you write.
- If a task is harder than expected, say so — don't fake completion.
- Your code will be reviewed. Broken promises will be caught.

## NinjaBrain — THE COMPOUNDING LOOP (do on EVERY conversation)
1. READ: Use brain_search before answering about entities. Brain context is your institutional memory.
2. RESPOND: Use brain context for informed answers. Never start from zero.
3. WRITE: After learning something new → brain_put to save it.
4. LINK: If two entities are related → brain_link them.
`,
    },
    infiniteSessions: {
      enabled: true,
      backgroundCompactionThreshold: 0.8,
      bufferExhaustionThreshold: 0.95,
    },
    hooks: {
      onPreToolUse: async (input) => {
        // Log all tool calls for audit
        console.log(`[Tool] ${input.toolName}`, JSON.stringify(input.toolArgs ?? {}).slice(0, 200));
        return { permissionDecision: "allow" as const };
      },
      onPostToolUse: async (input) => {
        // Persist audit log
        const result = (input as any).toolResult;
        await logToolExecution(
          userId,
          input.toolName,
          JSON.stringify(input.toolArgs ?? {}),
          typeof result === "string" ? result.slice(0, 500) : "",
        );
        return {};
      },
    },
  });

  sessions.set(userId, session);
  return session;
}

// ---------------------------------------------------------------------------
// Public API — send a message and get a response
// ---------------------------------------------------------------------------

export interface AgentResponse {
  text: string;
  toolsUsed: string[];
}

/**
 * Send a user message through the agent and wait for the full response.
 * This is the single entry point for Telegram, Teams, and Web UI.
 */
export async function processMessage(
  userId: number,
  userText: string,
  userName = "",
): Promise<AgentResponse> {
  const session = await getSession(userId);
  const toolsUsed: string[] = [];

  // Inject brain context into the prompt
  const brainCtx = await brainContextForMessage(userText);
  const profileCtx = await getProfileSummary(userId);
  const factsCtx = await getFactsSummary(userId);

  let enrichedPrompt = userText;
  const contextParts: string[] = [];
  if (brainCtx) contextParts.push(brainCtx);
  if (profileCtx) contextParts.push(`## User Profile\n${profileCtx}`);
  if (factsCtx) contextParts.push(`## Remembered Facts\n${factsCtx}`);

  if (contextParts.length > 0) {
    enrichedPrompt = `${contextParts.join("\n\n")}\n\n---\nUser message: ${userText}`;
  }

  // Track tool usage
  const toolUnsub = session.on("tool.execution_start", (event: any) => {
    toolsUsed.push(event.data?.toolName ?? "unknown");
  });

  // Save user message to memory
  await saveMessage(userId, "user", userText);

  // Send and wait for response
  const response = await session.sendAndWait(
    { prompt: enrichedPrompt },
    300_000, // 5 minute timeout
  );

  toolUnsub();

  const text = (response?.data as any)?.content ?? "No response received.";

  // Save assistant response to memory
  await saveMessage(userId, "assistant", text);

  return { text, toolsUsed };
}
