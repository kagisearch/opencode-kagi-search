import type { ToolResult } from "./types.js";

/** A single result entry from the Kagi v1 search API. */
export interface KagiResult {
  url: string;
  title: string;
  snippet?: string;
  time?: string;
  [key: string]: unknown;
}

/** Subset of the Kagi v1 search response the websearch provider maps from. */
export interface KagiSearchResponse {
  data?: {
    search?: KagiResult[];
    news?: KagiResult[];
    direct_answer?: KagiResult[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Shape OpenCode expects from a websearch provider result. */
export interface WebSearchResult {
  url: string;
  title: string;
  content?: string;
  time: { published?: number };
}

function publishedAt(time?: string): { published?: number } {
  if (!time) return {};
  const ms = Date.parse(time);
  return Number.isNaN(ms) ? {} : { published: ms };
}

/**
 * Map a Kagi search response to OpenCode websearch results. Falls back to
 * direct answers and news entries when the response has no web results.
 */
export function toWebResults(response: KagiSearchResponse): WebSearchResult[] {
  const d = response.data;
  const results = d?.search?.length ? d.search : [...(d?.direct_answer ?? []), ...(d?.news ?? [])];
  return results.map((r) => ({
    url: r.url,
    title: r.title,
    content: r.snippet,
    time: publishedAt(r.time),
  }));
}

export interface KagiWebsearchProvider {
  id: "kagi";
  name: "Kagi";
  execute(input: { query: string }, context: { signal: AbortSignal }): Promise<WebSearchResult[]>;
}

/**
 * Build the Kagi websearch provider around an injected search function, so
 * the mapping and error behavior stay testable without network access.
 */
export function createKagiProvider(
  search: (query: string, context: { signal: AbortSignal }) => Promise<ToolResult<KagiSearchResponse>>,
): KagiWebsearchProvider {
  return {
    id: "kagi",
    name: "Kagi",
    async execute({ query }, context) {
      const result = await search(query, { signal: context.signal });
      if (!result.ok) {
        throw new Error(result.error?.message ?? "Kagi search failed");
      }
      return toWebResults(result.data ?? {});
    },
  };
}
