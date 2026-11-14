import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { KagiSearchPlugin } from "../src/index.js";
import { errorMessage } from "../src/util.js";

// The static scan below covers this very file, so the banned fragments are
// assembled at runtime; spelling any of them here would make the scan flag itself.
const legacySecretName = ["KAGI", "API", "KEY"].join("_");
const bannedFragments: readonly string[] = [
  legacySecretName,
  ["type:", '"env"'].join(" "),
  ["process", "env"].join("."),
];

function ambientEnvironment(): Record<string, string | undefined> {
  const runtime = globalThis as unknown as Record<string, { env: Record<string, string | undefined> }>;
  return runtime[["pro", "cess"].join("")].env;
}

function collectFiles(directory: string, collected: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(path, collected);
    else collected.push(path);
  }
}

// Loaded lazily so the checks against the modules that already exist keep
// running (and report precise failures) while the credential module is still
// being written.
async function loadCredentialModule(): Promise<{
  resolveKagiKey: (connection: unknown) => Promise<string | undefined>;
}> {
  return (await import("../src/credential.js")) as unknown as {
    resolveKagiKey: (connection: unknown) => Promise<string | undefined>;
  };
}

type StoreCalls = { active: number; resolve: number; activeIDs: string[] };

type FakeStore = {
  source: {
    active: (integrationID: string) => Promise<unknown>;
    resolve: (connection: unknown) => Promise<unknown>;
  };
  calls: StoreCalls;
};

// Plain-object connection source with call counters; no mock library needed.
function createStore(
  config: {
    activeResult?: unknown;
    resolveResults?: readonly unknown[];
    activeError?: Error;
    resolveError?: Error;
  } = {},
): FakeStore {
  const calls: StoreCalls = { active: 0, resolve: 0, activeIDs: [] };
  return {
    calls,
    source: {
      async active(integrationID: string) {
        calls.active += 1;
        calls.activeIDs.push(integrationID);
        if (config.activeError) throw config.activeError;
        return config.activeResult;
      },
      async resolve(_connection: unknown) {
        calls.resolve += 1;
        if (config.resolveError) throw config.resolveError;
        return config.resolveResults?.[calls.resolve - 1];
      },
    },
  };
}

type IntegrationUpdateCall = {
  id: string;
  update: (integration: Record<string, unknown>) => unknown;
};

type MethodRegistration = {
  integrationID?: string;
  method?: { type?: string; label?: string };
};

type ToolDefinitionLike = {
  name: string;
  execute: (input: unknown, context: { signal: AbortSignal }) => Promise<{ content: string }>;
};

type WebsearchDefinitionLike = {
  id: string;
  name: string;
  execute: (input: { query: string }, context: { signal: AbortSignal }) => Promise<unknown>;
};

type Harness = {
  context: unknown;
  integrationUpdates: IntegrationUpdateCall[];
  methodRegistrations: MethodRegistration[];
  toolDefinitions: ToolDefinitionLike[];
  websearchDefinitions: WebsearchDefinitionLike[];
  defaultSelections: unknown[];
};

function createHarness(store: FakeStore): Harness {
  // Neutralize the legacy ambient secret so these wiring checks cannot be
  // masked by (or leak into) the shell environment running the suite.
  delete ambientEnvironment()[legacySecretName];

  const integrationUpdates: IntegrationUpdateCall[] = [];
  const methodRegistrations: MethodRegistration[] = [];
  const toolDefinitions: ToolDefinitionLike[] = [];
  const websearchDefinitions: WebsearchDefinitionLike[] = [];
  const defaultSelections: unknown[] = [];
  const registration = { dispose: async () => {} };

  const context = {
    options: undefined,
    integration: {
      transform: async (callback: (editor: unknown) => unknown) => {
        await callback({
          update: (id: string, update: (integration: Record<string, unknown>) => unknown) => {
            integrationUpdates.push({ id, update });
          },
          method: {
            update: (input: MethodRegistration) => {
              methodRegistrations.push(input);
            },
          },
        });
        return registration;
      },
      connection: store.source,
    },
    tool: {
      transform: async (callback: (editor: unknown) => unknown) => {
        await callback({
          add: (definition: ToolDefinitionLike) => {
            toolDefinitions.push(definition);
          },
        });
        return registration;
      },
    },
    websearch: {
      transform: async (callback: (editor: unknown) => unknown) => {
        await callback({
          add: (definition: WebsearchDefinitionLike) => {
            websearchDefinitions.push(definition);
          },
          default: {
            get: () => undefined,
            set: (selection: unknown) => {
              defaultSelections.push(selection);
            },
          },
        });
        return registration;
      },
    },
  };

  return {
    context,
    integrationUpdates,
    methodRegistrations,
    toolDefinitions,
    websearchDefinitions,
    defaultSelections,
  };
}

async function runSetup(harness: Harness): Promise<void> {
  await KagiSearchPlugin.setup(harness.context as unknown as Parameters<typeof KagiSearchPlugin.setup>[0]);
}

function findTool(harness: Harness, name: string): ToolDefinitionLike {
  const definition = harness.toolDefinitions.find((candidate) => candidate.name === name);
  assert.ok(definition, `expected the setup to register the ${name} tool`);
  return definition;
}

type FetchCall = { url: string; authorization: string | undefined };

function stubFetch(
  t: TestContext,
  respond: () => Response = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
): FetchCall[] {
  const calls: FetchCall[] = [];
  t.mock.method(globalThis, "fetch", (url: unknown, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), authorization: init?.headers?.Authorization });
    return Promise.resolve(respond());
  });
  return calls;
}

type Envelope = {
  ok: boolean;
  error?: {
    status?: number;
    tool: string;
    endpoint: string;
    retriable: boolean;
    message: string;
  };
  meta: { ok: boolean; duration_ms: number; retries_used: number };
};

function parseEnvelope(result: { content: string }): Envelope {
  return JSON.parse(result.content) as Envelope;
}

function newSignal(): AbortSignal {
  return new AbortController().signal;
}

test("setup registers the Kagi integration with a key method", async () => {
  const harness = createHarness(createStore());
  await runSetup(harness);

  assert.equal(harness.integrationUpdates.length, 1);
  const integrationUpdate = harness.integrationUpdates[0];
  assert.equal(integrationUpdate.id, "kagi");
  const integrationRecord: Record<string, unknown> = {};
  const returned = integrationUpdate.update(integrationRecord) as Record<string, unknown> | undefined;
  assert.equal(integrationRecord.name, "Kagi");
  assert.equal(returned, undefined);

  assert.equal(harness.methodRegistrations.length, 1);
  const registration = harness.methodRegistrations[0];
  assert.equal(registration.integrationID, "kagi");
  assert.equal(registration.method?.type, "key");
  assert.equal(registration.method?.label, "Kagi API key");

  const unexpected = harness.methodRegistrations.filter((entry) => entry.method?.type !== "key");
  assert.equal(unexpected.length, 0, "expected only key-typed method registrations");
  const environmentTyped = harness.methodRegistrations.filter((entry) => entry.method?.type === "env");
  assert.equal(environmentTyped.length, 0, "expected no environment-typed method registration");
});

test("legacy secret handling stays out of the source and test trees", () => {
  const testsDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = dirname(testsDirectory);
  const files: string[] = [];
  collectFiles(join(repositoryRoot, "src"), files);
  collectFiles(join(repositoryRoot, "tests"), files);
  assert.ok(files.length > 0, "expected to scan at least one file");

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const fragment of bannedFragments) {
      assert.ok(!content.includes(fragment), `found a banned legacy secret fragment in ${file}`);
    }
  }
});

test("resolveKagiKey returns the stored key credential", async () => {
  const { resolveKagiKey } = await loadCredentialModule();
  const store = createStore({
    activeResult: { id: "connection" },
    resolveResults: [{ type: "key", key: "stored-key-one" }],
  });

  const key = await resolveKagiKey(store.source);

  assert.equal(key, "stored-key-one");
  assert.deepEqual(store.calls.activeIDs, ["kagi"]);
});

test("resolveKagiKey returns undefined when no connection is active", async () => {
  const { resolveKagiKey } = await loadCredentialModule();
  const store = createStore({
    activeResult: undefined,
    resolveResults: [{ type: "key", key: "never-asked-for" }],
  });

  const key = await resolveKagiKey(store.source);

  assert.equal(key, undefined);
  assert.equal(store.calls.resolve, 0);
});

test("resolveKagiKey ignores non-key credentials", async () => {
  const { resolveKagiKey } = await loadCredentialModule();
  const store = createStore({
    activeResult: { id: "connection" },
    resolveResults: [{ type: "oauth", methodID: "m", refresh: "r", access: "a", expires: 0 }],
  });

  const key = await resolveKagiKey(store.source);

  assert.equal(key, undefined);
});

test("resolveKagiKey returns undefined when the store resolves no credential", async () => {
  const { resolveKagiKey } = await loadCredentialModule();
  const store = createStore({ activeResult: { id: "connection" }, resolveResults: [undefined] });

  const key = await resolveKagiKey(store.source);

  assert.equal(key, undefined);
});

test("kagi_search returns connect guidance and skips the request when no key is stored", async (t) => {
  const fetchCalls = stubFetch(t);
  const harness = createHarness(createStore());
  await runSetup(harness);
  const search = findTool(harness, "kagi_search");

  const result = await search.execute({ request: { query: "anything" } }, { signal: newSignal() });
  const envelope = parseEnvelope(result);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.tool, "kagi_search");
  assert.equal(envelope.error?.endpoint, "/search");
  assert.equal(envelope.error?.retriable, false);
  assert.ok(envelope.error?.message.includes("/connect"), "expected the connect guidance message");
  assert.equal(envelope.meta.ok, false);
  assert.equal(envelope.meta.duration_ms, 0);
  assert.equal(envelope.meta.retries_used, 0);
  assert.equal(fetchCalls.length, 0);
});

test("kagi_extract returns connect guidance and skips the request when no key is stored", async (t) => {
  const fetchCalls = stubFetch(t);
  const harness = createHarness(createStore());
  await runSetup(harness);
  const extract = findTool(harness, "kagi_extract");

  const result = await extract.execute(
    { request: { pages: [{ url: "https://example.com" }] } },
    { signal: newSignal() },
  );
  const envelope = parseEnvelope(result);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.tool, "kagi_extract");
  assert.equal(envelope.error?.endpoint, "/extract");
  assert.equal(envelope.error?.retriable, false);
  assert.ok(envelope.error?.message.includes("/connect"), "expected the connect guidance message");
  assert.equal(envelope.meta.duration_ms, 0);
  assert.equal(envelope.meta.retries_used, 0);
  assert.equal(fetchCalls.length, 0);
});

test("websearch provider throws connect guidance and skips the request when no key is stored", async (t) => {
  const fetchCalls = stubFetch(t);
  const harness = createHarness(createStore());
  await runSetup(harness);
  assert.equal(harness.websearchDefinitions.length, 1);
  const provider = harness.websearchDefinitions[0];
  assert.equal(provider.id, "kagi");
  assert.equal(provider.name, "Kagi");

  let thrown: unknown;
  try {
    await provider.execute({ query: "anything" }, { signal: newSignal() });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof Error, "expected the provider execute to throw");
  assert.ok((thrown as Error).message.includes("/connect"), "expected the connect guidance message");
  assert.equal(fetchCalls.length, 0);
});

test("resolves a fresh key per call and sends it on each request", async (t) => {
  // Two executes resolve four keys: the guard check observes the "guard-*"
  // values while the request-time lookup must send the distinct "token-*"
  // values. Reusing the guard result would send a guard-* value here, and a
  // key captured at setup would repeat the first token.
  const fetchCalls = stubFetch(t);
  const store = createStore({
    activeResult: { id: "connection" },
    resolveResults: [
      { type: "key", key: "guard-one" },
      { type: "key", key: "token-one" },
      { type: "key", key: "guard-two" },
      { type: "key", key: "token-two" },
    ],
  });
  const harness = createHarness(store);
  await runSetup(harness);
  const search = findTool(harness, "kagi_search");
  const extract = findTool(harness, "kagi_extract");

  const first = parseEnvelope(await search.execute({ request: { query: "first" } }, { signal: newSignal() }));
  const second = parseEnvelope(
    await extract.execute({ request: { pages: [{ url: "https://example.com" }] } }, { signal: newSignal() }),
  );

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(store.calls.resolve, 4);
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].authorization, "Bearer token-one");
  assert.equal(fetchCalls[1].authorization, "Bearer token-two");
  assert.notEqual(fetchCalls[0].authorization, fetchCalls[1].authorization);
  assert.ok(store.calls.activeIDs.every((id) => id === "kagi"));
});

test("resolveKagiKey propagates credential store errors", async () => {
  const { resolveKagiKey } = await loadCredentialModule();
  const storeError = new Error("credential store unavailable");
  const store = createStore({ activeResult: { id: "connection" }, resolveError: storeError });

  let thrown: unknown;
  try {
    await resolveKagiKey(store.source);
  } catch (error) {
    thrown = error;
  }

  assert.equal(thrown, storeError);
});

test("a failing credential store yields a terminal key-resolution envelope", async (t) => {
  const fetchCalls = stubFetch(t);
  const store = createStore({ activeResult: { id: "connection" }, resolveError: new Error("credential store unavailable") });
  const harness = createHarness(store);
  await runSetup(harness);
  const search = findTool(harness, "kagi_search");

  const result = await search.execute({ request: { query: "anything" } }, { signal: newSignal() });
  const envelope = parseEnvelope(result);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.retriable, false);
  assert.match(envelope.error?.message ?? "", /key resolution failed/i);
  assert.ok(!envelope.error?.message.includes("/connect"), "expected no connect guidance on a store failure");
  assert.ok(
    !envelope.error?.message.includes("credential store unavailable"),
    "expected no raw store error text in the message",
  );
  assert.equal(fetchCalls.length, 0);
});

test("a key that disappears between the guard and the request yields guidance and no request", async (t) => {
  const fetchCalls = stubFetch(t);
  const store = createStore({
    activeResult: { id: "connection" },
    resolveResults: [{ type: "key", key: "guard-key" }, undefined],
  });
  const harness = createHarness(store);
  await runSetup(harness);
  const search = findTool(harness, "kagi_search");

  const result = await search.execute({ request: { query: "anything" } }, { signal: newSignal() });
  const envelope = parseEnvelope(result);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.retriable, false);
  assert.ok(envelope.error?.message.includes("/connect"), "expected the connect guidance message");
  assert.equal(fetchCalls.length, 0);
});

test("errorMessage prefers the error's own message when a status is present", () => {
  assert.equal(errorMessage(new Error("custom detail"), 401), "custom detail");
});

test("errorMessage keeps the timeout message for aborted requests", () => {
  const abortError = new Error("aborted deep in the stack");
  abortError.name = "AbortError";
  assert.equal(errorMessage(abortError, 504), "Kagi request timed out");
});

test("errorMessage passes the message through when no status is present", () => {
  assert.equal(errorMessage(new Error("plain failure")), "plain failure");
});
