import type { Endpoint, ToolName, ToolResult } from "./types.js";

// Structural stand-in for the SDK credential union, narrowed to the fields this plugin reads.
type KagiCredentialValue = {
  type?: string;
  key?: string;
};

/**
 * Narrow structural view of `ctx.integration.connection`, so credential access
 * stays testable and independent of SDK connection type details.
 */
export interface KagiConnectionSource<TConnection = unknown> {
  active(integrationID: string): Promise<TConnection | undefined>;
  resolve(connection: TConnection): Promise<KagiCredentialValue | undefined>;
}

/**
 * Resolve the Kagi API key from OpenCode's credential store on every call.
 * Credential store errors propagate with their identity preserved so callers
 * can tell "not connected" apart from "the store itself failed".
 */
export async function resolveKagiKey<TConnection>(
  connection: KagiConnectionSource<TConnection>,
): Promise<string | undefined> {
  const activeConnection = await connection.active("kagi");
  if (!activeConnection) return undefined;
  const credential = await connection.resolve(activeConnection);
  return credential?.type === "key" ? credential.key : undefined;
}

// Terminal guidance for the missing-key case: there is no programmatic form
// prompt in the plugin SDK, so the user is pointed at the built-in connect
// flows and the call is not retried.
export const MISSING_KEY_GUIDANCE =
  "Kagi is not connected. Run /connect in the OpenCode TUI (choose Kagi, then paste your API key) " +
  "or `opencode auth login kagi --method key` in the CLI, then retry.";

// Static text for store failures: raw store error details must never reach
// user-facing output, and the resolution path is terminal (no retry).
export const KEY_RESOLUTION_FAILED_MESSAGE =
  "Kagi key resolution failed; the credential store could not provide a usable key.";

function terminalResult(tool: ToolName, endpoint: Endpoint, message: string): ToolResult<never> {
  return {
    ok: false,
    error: {
      tool,
      endpoint,
      retriable: false,
      message,
    },
    meta: { ok: false, duration_ms: 0, retries_used: 0 },
  };
}

function missingKeyResult(tool: ToolName, endpoint: Endpoint): ToolResult<never> {
  return terminalResult(tool, endpoint, MISSING_KEY_GUIDANCE);
}

function keyResolutionFailedResult(tool: ToolName, endpoint: Endpoint): ToolResult<never> {
  return terminalResult(tool, endpoint, KEY_RESOLUTION_FAILED_MESSAGE);
}

/**
 * Guard helper used by every call site before any network access: returns the
 * freshly resolved key, or a terminal envelope (connect guidance when no key
 * is stored, key-resolution-failed text when the store errors).
 */
export async function resolveKagiKeyOrFail<TConnection>(
  connection: KagiConnectionSource<TConnection>,
  tool: ToolName,
  endpoint: Endpoint,
): Promise<string | ToolResult<never>> {
  try {
    const key = await resolveKagiKey(connection);
    // An empty key is unusable, so treat it as missing rather than letting an
    // unauthenticated request reach Kagi.
    if (!key) return missingKeyResult(tool, endpoint);
    return key;
  } catch {
    return keyResolutionFailedResult(tool, endpoint);
  }
}
