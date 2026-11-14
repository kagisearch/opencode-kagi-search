import { Plugin } from "@opencode/plugin";
import {
  KEY_RESOLUTION_FAILED_MESSAGE,
  MISSING_KEY_GUIDANCE,
  resolveKagiKey,
  resolveKagiKeyOrFail,
} from "./credential.js";
// Local vendored wrapper for the upstream generated Kagi client.
import { createConfiguration as createKagiConfiguration, ExtractApi, SearchApi } from "./vendor/kagi-api.js";
import { RUNTIME_CONFIG, runKagiOperation } from "./util.js";
import { createKagiProvider, type KagiSearchResponse } from "./websearch.js";
import type { ExtractRequest, SearchRequest } from "./types.js";

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

// Attaching a numeric code lets getStatus classify this as HTTP 401,
// which isRetriableStatus treats as non-retriable, so an unusable key
// never triggers request retries.
function credentialAccessError(message: string): Error {
  return Object.assign(new Error(message), { code: 401 });
}

export const KagiSearchPlugin = Plugin.define({
  id: "opencode-kagi-search",

  async setup(ctx) {
    const options = ctx.options as { defaultProvider?: boolean } | undefined;
    const connection = ctx.integration.connection;

    await ctx.integration.transform((editor) => {
      editor.update("kagi", (integration) => {
        integration.name = "Kagi";
      });
      editor.method.update({
        integrationID: "kagi",
        method: { type: "key", label: "Kagi API key" },
      });
    });

    const kagiConfig = createKagiConfiguration({
      authMethods: {
        kagi: {
          tokenProvider: {
            // Resolve per request (never at setup) so a rotated or re-stored
            // key takes effect on the very next call.
            getToken: async () => {
              let key: string | undefined;
              try {
                key = await resolveKagiKey(connection);
              } catch {
                throw credentialAccessError(KEY_RESOLUTION_FAILED_MESSAGE);
              }
              if (!key) throw credentialAccessError(MISSING_KEY_GUIDANCE);
              return key;
            },
          },
        },
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
        const resolved = await resolveKagiKeyOrFail(connection, "kagi_search", "/search");
        if (typeof resolved !== "string") return resolved;
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
          const resolved = await resolveKagiKeyOrFail(connection, "kagi_search", "/search");
          const result =
            typeof resolved === "string"
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
              : resolved;
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
          const resolved = await resolveKagiKeyOrFail(connection, "kagi_extract", "/extract");
          const result =
            typeof resolved === "string"
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
              : resolved;
          return { content: JSON.stringify(result, null, 2) };
        },
      });
    });

    console.log(
      `[opencode-kagi-search] initialized (timeout_ms=${RUNTIME_CONFIG.timeoutMs}, max_retries=${RUNTIME_CONFIG.maxRetries}); the API key resolves from OpenCode's credential store per call.`,
    );
  },
});

export default KagiSearchPlugin;
