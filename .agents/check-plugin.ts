import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import type { Result as ToolResult, ToolContext } from "@opencode/plugin/promise/tool";

import pluginDefinition from "../src/plugin";
import type { MemoryToolDefinition } from "../src/tools";

// Exercise the real V2 plugin end-to-end against a fake host context:
// setup() registration, the session "context" hook, tools via the editor,
// and journal embeddings. This is not a substitute for an actual OpenCode
// session test.

type ContextHook = (event: {
  sessionID: string;
  agent: string;
  model: { providerID: string; id: string };
  kind: string;
  system: Array<{ type: "text"; text: string }>;
  messages: unknown[];
  tools: Record<string, unknown>;
  options: Record<string, unknown>;
}) => Promise<void> | void;

// Mirrors createFakeContext() in src/plugin.test.ts.
function createFakeContext(directory: string) {
  const hooks: Array<{ name: string; callback: ContextHook }> = [];
  const tools: MemoryToolDefinition[] = [];
  const ctx = {
    location: { directory },
    options: {},
    session: {
      hook: async (name: string, callback: ContextHook) => {
        hooks.push({ name, callback });
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          add: (tool: MemoryToolDefinition) => {
            tools.push(tool);
          },
        });
        return { dispose: async () => {} };
      },
    },
  } as unknown as Plugin.Context;
  return { ctx, hooks, tools };
}

function createContextEvent() {
  return {
    sessionID: "smoke-session",
    agent: "smoke-agent",
    model: { providerID: "smoke-provider", id: "smoke-model" },
    kind: "primary",
    system: [
      { type: "text" as const, text: "provider-header" },
      { type: "text" as const, text: "existing-instructions" },
    ],
    messages: [] as unknown[],
    tools: {} as Record<string, unknown>,
    options: {} as Record<string, unknown>,
  };
}

// Branded-string casts match src/plugin.test.ts.
const toolCtx: ToolContext = {
  sessionID: "smoke-session" as ToolContext["sessionID"],
  agent: "smoke-agent" as ToolContext["agent"],
  messageID: "smoke-message" as ToolContext["messageID"],
  id: "smoke-call" as ToolContext["id"],
  progress: async () => {},
};

// These tools always return a plain string as Tool.Result.content.
function textContent(result: ToolResult<undefined>): string {
  return result.content as string;
}

// Bun captures the home directory at startup, so isolation needs a new process.
if (!process.argv.includes("--isolated")) {
  const root = await mkdtemp(join(tmpdir(), "agent-memory-smoke-"));
  let result: number;
  try {
    result = Bun.spawnSync([process.execPath, import.meta.path, "--isolated"], {
      env: { ...process.env, HOME: root },
      stdout: "inherit",
      stderr: "inherit",
    }).exitCode;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  process.exit(result);
}

const root = homedir();
const directory = join(root, "project");
const configDir = join(root, ".config", "opencode");
await mkdir(configDir, { recursive: true });

// Phase 1: default settings (journal off) register only the three memory tools.
{
  const { ctx, hooks, tools } = createFakeContext(directory);
  await pluginDefinition.setup(ctx);
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["memory_list", "memory_replace", "memory_set"],
  );
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0]!.name, "context");
}

// Phase 2: journal enabled adds the three journal tools.
await writeFile(join(configDir, "agent-memory.json"), '{"journal":{"enabled":true}}');
const { ctx, hooks, tools } = createFakeContext(directory);
await pluginDefinition.setup(ctx);
assert.equal(tools.length, 6);
const byName = new Map(tools.map((t) => [t.name, t]));

// The context hook injects memory blocks after the provider header, captures
// the resolved model for journal metadata, and appends the journal note.
const contextHook = hooks.find((h) => h.name === "context")!;
const event = createContextEvent();
await contextHook.callback(event);
assert.equal(event.system[0]!.text, "provider-header");
assert.ok(event.system[1]!.text.includes("persona"));
assert.equal(event.system[2]!.text, "existing-instructions");
assert.ok(event.system.at(-1)!.text.includes("journal"));

// Memory mutation round-trip, verified through a fresh context injection.
await byName.get("memory_set")!.execute({ label: "orb-check", value: "orb-original-marker" }, toolCtx);
await byName.get("memory_replace")!.execute({ label: "orb-check", oldText: "original", newText: "updated" }, toolCtx);
const mutated = createContextEvent();
await contextHook.callback(mutated);
const prompt = mutated.system.map((chunk) => chunk.text).join("\n");
assert.ok(prompt.includes("orb-updated-marker"));
assert.ok(!prompt.includes("orb-original-marker"));
assert.ok(textContent(await byName.get("memory_list")!.execute({}, toolCtx)).includes("project:orb-check"));

// Journal: metadata captured from the context hook, real embeddings on disk.
await byName.get("journal_write")!.execute(
  { title: "Fetch", body: "The puppy chased a ball in the garden." },
  toolCtx,
);
const journalDir = join(configDir, "journal");
const filename = (await readdir(journalDir)).find((name) => name.endsWith(".md"))!;
const id = filename.slice(0, -3);
const embedding = JSON.parse(await readFile(join(journalDir, `${id}.embedding`), "utf8"));
assert.equal(embedding.length, 384);
assert.ok(embedding.every(Number.isFinite));
const entry = textContent(await byName.get("journal_read")!.execute({ id }, toolCtx));
for (const value of ["smoke-model", "smoke-provider", "smoke-agent", "smoke-session"]) {
  assert.ok(entry.includes(value));
}
// A paraphrase with no literal substring match requires real semantic search.
const search = textContent(await byName.get("journal_search")!.execute({ text: "A dog playing outdoors" }, toolCtx));
assert.ok(search.includes(id));

console.log("Plugin OK: V2 setup, journal off/on, memory mutation, context-hook injection, journal metadata, embeddings and semantic search");
