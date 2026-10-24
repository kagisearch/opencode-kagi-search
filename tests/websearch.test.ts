import assert from "node:assert/strict";
import { test } from "node:test";

import { toWebResults, createKagiProvider } from "../src/websearch.js";
import type { KagiSearchResponse } from "../src/websearch.js";
import type { ToolResult } from "../src/types.js";

function okResult(data: KagiSearchResponse): ToolResult<KagiSearchResponse> {
  return { ok: true, data, meta: { ok: true, duration_ms: 1, retries_used: 0 } };
}

test("maps Kagi search results to websearch results", () => {
  const response: KagiSearchResponse = {
    data: {
      search: [
        {
          url: "https://example.com/a",
          title: "Example A",
          snippet: "Snippet A",
          time: "2026-10-01T00:00:00Z",
        },
      ],
    },
  };

  const results = toWebResults(response);

  assert.equal(results.length, 1);
  assert.equal(results[0].url, "https://example.com/a");
  assert.equal(results[0].title, "Example A");
  assert.equal(results[0].content, "Snippet A");
  assert.equal(results[0].time?.published, Date.parse("2026-10-01T00:00:00Z"));
});

test("falls back to direct answers and news when search is empty", () => {
  const response: KagiSearchResponse = {
    data: {
      direct_answer: [{ url: "https://example.com/answer", title: "Answer", snippet: "42" }],
      news: [{ url: "https://example.com/news", title: "News", snippet: "Breaking" }],
      search: [],
    },
  };

  const results = toWebResults(response);

  assert.deepEqual(
    results.map((r) => r.url),
    ["https://example.com/answer", "https://example.com/news"],
  );
});

test("omits time when the timestamp is missing or unparsable", () => {
  const response: KagiSearchResponse = {
    data: {
      search: [
        { url: "https://example.com/no-time", title: "No time" },
        { url: "https://example.com/bad-time", title: "Bad time", time: "not-a-date" },
      ],
    },
  };

  const results = toWebResults(response);

  assert.deepEqual(results[0].time, {});
  assert.deepEqual(results[1].time, {});
});

test("provider returns mapped results on success", async () => {
  const provider = createKagiProvider(async () =>
    okResult({
      data: { search: [{ url: "https://example.com", title: "Example", snippet: "S" }] },
    }),
  );

  const results = await provider.execute({ query: "anything" }, { signal: new AbortController().signal });

  assert.equal(provider.id, "kagi");
  assert.equal(provider.name, "Kagi");
  assert.equal(results.length, 1);
  assert.equal(results[0].url, "https://example.com");
});

test("provider passes the query to the search function", async () => {
  let seen = "";
  const provider = createKagiProvider(async (query) => {
    seen = query;
    return okResult({ data: { search: [] } });
  });

  await provider.execute({ query: "hello kagi" }, { signal: new AbortController().signal });

  assert.equal(seen, "hello kagi");
});

test("provider forwards the context signal to the search function", async () => {
  let received: AbortSignal | undefined;
  const provider = createKagiProvider(async (_query, context) => {
    received = context.signal;
    return okResult({ data: { search: [] } });
  });

  const controller = new AbortController();
  await provider.execute({ query: "x" }, { signal: controller.signal });

  assert.equal(received, controller.signal);
});

test("provider throws a descriptive error when the API call fails", async () => {
  const provider = createKagiProvider(async () => ({
    ok: false as const,
    error: {
      tool: "kagi_search" as const,
      endpoint: "/search" as const,
      retriable: false,
      message: "Kagi API request failed with status 401",
    },
    meta: { ok: false, duration_ms: 1, retries_used: 0 },
  }));

  await assert.rejects(
    () => provider.execute({ query: "x" }, { signal: new AbortController().signal }),
    /status 401/,
  );
});
