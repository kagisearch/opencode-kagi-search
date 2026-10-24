import assert from "node:assert/strict";
import { test } from "node:test";

import { runKagiOperation } from "../src/util.js";

test("external abort cancels the operation promptly without retries", async () => {
  const controller = new AbortController();
  // The operation observes ONLY the signal runKagiOperation hands it,
  // so this test proves the external signal is actually plumbed through.
  const operation = (signal: AbortSignal) =>
    new Promise<string>((_, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("Request aborted");
        error.name = "AbortError";
        reject(error);
      });
    });

  const start = Date.now();
  const resultPromise = runKagiOperation<string>(
    operation,
    { tool: "kagi_search", endpoint: "/search", timeoutMs: 5000, retries: 2 },
    { signal: controller.signal },
  );

  controller.abort();
  const settled = await resultPromise;
  const elapsed = Date.now() - start;

  assert.equal(settled.ok, false);
  assert.ok(elapsed < 1500, `expected prompt cancellation, took ${elapsed}ms`);
});

test("completes normally when the external signal never aborts", async () => {
  const result = await runKagiOperation(
    async () => "done",
    { tool: "kagi_search", endpoint: "/search", timeoutMs: 1000, retries: 0 },
    { signal: new AbortController().signal },
  );

  assert.equal(result.ok, true);
  assert.equal(result.data, "done");
});

test("external abort during retry backoff returns without starting another attempt", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const resultPromise = runKagiOperation(
    async () => {
      attempts++;
      throw new Error("temporary network failure");
    },
    { tool: "kagi_search", endpoint: "/search", timeoutMs: 5000, retries: 2 },
    { signal: controller.signal },
  );

  setTimeout(() => controller.abort(), 10);
  const result = await resultPromise;

  assert.equal(result.ok, false);
  assert.equal(result.error?.retriable, false);
  assert.equal(attempts, 1);
});
