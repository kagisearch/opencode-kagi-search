import { Plugin } from "@opencode/plugin";
// Local vendored wrapper for the upstream generated Kagi client.
import { createConfiguration as createKagiConfiguration, ExtractApi, SearchApi } from "./vendor/kagi-api.js";
import { RUNTIME_CONFIG, runKagiOperation } from "./util.js";
import { createKagiProvider, type KagiSearchResponse } from "./websearch.js";
import type { ExtractRequest, SearchRequest, ToolResult } from "./types.js";

const searchInputSchema = {
  type: "object",
  properties: {
    request: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        workflow: { type: "string", enum: ["search", "images", "videos", "news", "podcasts"] },
        format: { type: "string", enum: ["json", "markdown"] },
        lensId: { type: "string" },
        lens: { type: "object", additionalProperties: true },
        timeout: { type: "number", exclusiveMinimum: 0 },
        page: { type: "integer", minimum: 1, maximum: 10 },
        limit: { type: "integer", minimum: 1, maximum: 1024 },
        filters: { type: "object", additionalProperties: true },
        extract: { type: "object", additionalProperties: true },
        safeSearch: { type: "boolean" },
        personalizations: { type: "object", additionalProperties: true },
      },
      required: ["query"],
      additionalProperties: true,
    },
  },
  required: ["request"],
} as const;

const extractInputSchema = {
  type: "object",
  properties: {
    request: {
      type: "object",
      properties: {
        pages: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: {
            type: "object",
            properties: { url: { type: "string", minLength: 1 } },
            required: ["url"],
            additionalProperties: true,
          },
        },
        timeout: { type: "number", exclusiveMinimum: 0 },
        format: { type: "string", enum: ["json", "markdown"] },
      },
      required: ["pages"],
      additionalProperties: true,
    },
  },
  required: ["request"],
} as const;

function validateSearchRequest(request: SearchRequest | undefined): void {
  if (!request || typeof request.query !== "string" || request.query.trim().length === 0) {
    throw new Error("kagi_search requires a non-empty 'query' string.");
  }
}

function validateExtractRequest(request: ExtractRequest | undefined): void {
  if (!request || !Array.isArray(request.pages) || request.pages.length === 0) {
    throw new Error("kagi_extract requires 'pages' with at least one URL.");
  }
  if (request.pages.length > 10) {
    throw new Error("kagi_extract supports at most 10 pages per request.");
  }
  for (const page of request.pages) {
    if (!page || typeof page.url !== "string" || page.url.trim().length === 0) {
      throw new Error("Each page must include a non-empty 'url' string.");
    }
    let parsed: URL;
    try {
      parsed = new URL(page.url);
    } catch {
      throw new Error("Each page URL must be a valid absolute URL.");
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      throw new Error("Each page URL must start with http:// or https://.");
    }
  }
}

function missingKeyResult(tool: "kagi_search" | "kagi_extract", endpoint: "/search" | "/extract"): ToolResult<never> {
  return {
    ok: false,
    error: {
      tool,
      endpoint,
      retriable: false,
      message:
        "KAGI_API_KEY is not set. Provide it in the OpenCode server environment " +
        "(e.g. `KAGI_API_KEY=... opencode`) before using the Kagi tools.",
    },
    meta: { ok: false, duration_ms: 0, retries_used: 0 },
  };
}

export const KagiSearchPlugin = Plugin.define({
  id: "opencode-kagi-search",

  async setup(ctx) {
    const options = ctx.options as { defaultProvider?: boolean } | undefined;
    const apiKey = process.env.KAGI_API_KEY ?? "";

    if (!apiKey) {
      console.log(
        "[opencode-kagi-search] KAGI_API_KEY is not set; Kagi tools will return an error until it is provided.",
      );
    }

    const kagiConfig = createKagiConfiguration({
      authMethods: {
        kagi: { tokenProvider: { getToken: () => apiKey } },
      },
    });

    const searchApi = new SearchApi(kagiConfig);
    const extractApi = new ExtractApi(kagiConfig);

    const withSignal = (signal: AbortSignal) => ({
      middleware: [
        {
          async pre(context: { setSignal: (signal: AbortSignal) => void }) {
            context.setSignal(signal);
            return context;
          },
          async post(context: unknown) {
            return context;
          },
        },
      ],
    });

    // Register Kagi as an OpenCode websearch provider, so the built-in
    // `websearch` tool can route queries through Kagi. Set the plugin option
    // `defaultProvider: true` to also select it as the default provider.
    await ctx.websearch.transform((editor) => {
      const provider = createKagiProvider(async (query, { signal }) => {
        if (!apiKey) return missingKeyResult("kagi_search", "/search") as ToolResult<KagiSearchResponse>;
        return runKagiOperation<KagiSearchResponse>(
          (attemptSignal) => searchApi.search<KagiSearchResponse>({ query, limit: 10 }, withSignal(attemptSignal)),
          {
            tool: "kagi_search",
            endpoint: "/search",
            timeoutMs: RUNTIME_CONFIG.timeoutMs,
            retries: RUNTIME_CONFIG.maxRetries,
          },
          { signal },
        );
      });

      editor.add({
        id: provider.id,
        name: provider.name,
        execute: provider.execute,
      });

      if (options?.defaultProvider === true) {
        editor.default.set("kagi");
      }
    });

    // Standalone tools with full request schema passthrough, as in v1.
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "kagi_search",
        description: "Run Kagi v1 search API with full request schema passthrough.",
        input: searchInputSchema,
        async execute(input, context) {
          const request = (input as { request?: SearchRequest }).request;
          validateSearchRequest(request);
          const result = apiKey
            ? await runKagiOperation(
                (signal) => searchApi.search(request as never, withSignal(signal)),
                {
                  tool: "kagi_search",
                  endpoint: "/search",
                  timeoutMs: RUNTIME_CONFIG.timeoutMs,
                  retries: RUNTIME_CONFIG.maxRetries,
                },
                { signal: context.signal },
              )
            : missingKeyResult("kagi_search", "/search");
          return { content: JSON.stringify(result, null, 2) };
        },
      });

      editor.add({
        name: "kagi_extract",
        description: "Run Kagi v1 extract API with full request schema passthrough.",
        input: extractInputSchema,
        async execute(input, context) {
          const request = (input as { request?: ExtractRequest }).request;
          validateExtractRequest(request);
          const result = apiKey
            ? await runKagiOperation(
                (signal) => extractApi.extractContent(request as never, withSignal(signal)),
                {
                  tool: "kagi_extract",
                  endpoint: "/extract",
                  timeoutMs: RUNTIME_CONFIG.timeoutMs,
                  retries: RUNTIME_CONFIG.maxRetries,
                },
                { signal: context.signal },
              )
            : missingKeyResult("kagi_extract", "/extract");
          return { content: JSON.stringify(result, null, 2) };
        },
      });
    });

    console.log(
      `[opencode-kagi-search] initialized (timeout_ms=${RUNTIME_CONFIG.timeoutMs}, max_retries=${RUNTIME_CONFIG.maxRetries}, api_key=${apiKey ? "present" : "missing"})`,
    );
  },
});

export default KagiSearchPlugin;
