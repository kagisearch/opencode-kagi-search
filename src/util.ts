import type { RequestContext, RuntimeConfig, ToolResult } from "./types.js";

export const RUNTIME_CONFIG: RuntimeConfig = {
  timeoutMs: 30000,
  maxRetries: 2,
  initialBackoffMs: 300,
  maxBackoffMs: 3000,
};

export async function runKagiOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  context: RequestContext,
  options: { signal?: AbortSignal } = {},
): Promise<ToolResult<T>> {
  const start = Date.now();
  let retriesUsed = 0;

  for (let attempt = 0; attempt <= context.retries; attempt++) {
    try {
      const data = await withTimeout(operation, context.timeoutMs, options.signal);
      return {
        ok: true,
        data,
        meta: {
          ok: true,
          duration_ms: Date.now() - start,
          retries_used: retriesUsed,
        },
      };
    } catch (error) {
      const status = getStatus(error);
      const externallyAborted = options.signal?.aborted === true;
      const retriable = !externallyAborted && (status === undefined || isRetriableStatus(status));

      if (retriable && attempt < context.retries) {
        retriesUsed = attempt + 1;
        await backoffDelay(attempt);
        continue;
      }

      return {
        ok: false,
        error: {
          status,
          tool: context.tool,
          endpoint: context.endpoint,
          retriable,
          message: errorMessage(error, status),
          body: getBody(error),
        },
        meta: {
          ok: false,
          status,
          request_id: getRequestId(error),
          duration_ms: Date.now() - start,
          retries_used: retriesUsed,
        },
      };
    }
  }

  return {
    ok: false,
    error: {
      tool: context.tool,
      endpoint: context.endpoint,
      retriable: false,
      message: "Kagi request failed unexpectedly",
    },
    meta: {
      ok: false,
      duration_ms: Date.now() - start,
      retries_used: retriesUsed,
    },
  };
}

export function isRetriableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function backoffDelay(attempt: number): Promise<void> {
  const exp = Math.min(RUNTIME_CONFIG.maxBackoffMs, RUNTIME_CONFIG.initialBackoffMs * (2 ** attempt));
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exp * 0.2)));
  const delayMs = Math.min(RUNTIME_CONFIG.maxBackoffMs, exp + jitter);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function errorMessage(error: unknown, status?: number): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "Kagi request timed out";
    return status ? `Kagi API request failed with status ${status}` : error.message;
  }
  return status ? `Kagi API request failed with status ${status}` : "Unknown request error";
}

function getStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "number") return code;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function getBody(error: unknown): unknown {
  return error && typeof error === "object" && "body" in error ? (error as { body?: unknown }).body : undefined;
}

function getRequestId(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("headers" in error)) return undefined;
  const headers = (error as { headers?: unknown }).headers;
  if (!headers || typeof headers !== "object") return undefined;
  const requestId = (headers as Record<string, unknown>)["x-request-id"];
  return typeof requestId === "string" ? requestId : undefined;
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const signal = controller.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const timeoutPromise = new Promise<T>((_, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        const error = new Error("Request aborted");
        error.name = "AbortError";
        reject(error);
      },
      { once: true },
    );
  });

  try {
    return await Promise.race([operation(signal), timeoutPromise]);
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}
