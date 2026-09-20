import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import type { Result as ToolResult, ToolContext } from "@opencode/plugin/promise/tool";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createMemoryStore } from "./memory";
import pluginDefinition from "./plugin";
import type { MemoryToolDefinition } from "./tools";

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

function createEvent(systemTexts: string[]) {
  return {
    sessionID: "test-session",
    agent: "test-agent",
    model: { providerID: "test-provider", id: "test-model" },
    kind: "primary",
    system: systemTexts.map((text) => ({ type: "text" as const, text })),
    messages: [] as unknown[],
    tools: {} as Record<string, unknown>,
    options: {} as Record<string, unknown>,
  };
}

// Structurally complete ToolContext stub; the per-field `as` casts are only
// needed because sessionID/agent/messageID/id are branded string types
// (indexed off ToolContext so we don't import @opencode/schema directly).
const toolCtx: ToolContext = {
  sessionID: "test-session" as ToolContext["sessionID"],
  agent: "test-agent" as ToolContext["agent"],
  messageID: "test-message" as ToolContext["messageID"],
  id: "test-call" as ToolContext["id"],
  progress: async () => {},
};

// Tool.Result.content is `string | ReadonlyArray<Content> | undefined`;
// these tools always return a plain string.
function textContent(result: ToolResult<undefined>): string {
  return result.content as string;
}

describe("memory plugin configuration", () => {
  test("exports an OpenCode V2 plugin definition", () => {
    expect(pluginDefinition.id).toBe("opencode-agent-memory");
    expect(typeof pluginDefinition.setup).toBe("function");
  });

  let home: string;
  let directory: string;
  let configDir: string;
  let homedirSpy: { mockRestore(): void };

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join("/tmp/", "opencode-plugin-"));
    homedirSpy = spyOn(os, "homedir").mockReturnValue(home);
    directory = path.join(home, "project");
    configDir = path.join(home, ".config", "opencode");
    await fs.mkdir(configDir, { recursive: true });
  });

  afterEach(async () => {
    homedirSpy.mockRestore();
    await fs.rm(home, { recursive: true, force: true });
  });

  test.each([
    ["omitted", {}, true],
    ["false", { memory: { disable_global: false } }, true],
    ["true", { memory: { disable_global: true } }, false],
    ["invalid journal", {
      memory: { disable_global: true },
      journal: { enabled: true, tags: [{ name: "perf" }] },
    }, false],
    ["journal enabled", {
      memory: { disable_global: true },
      journal: { enabled: true, tags: [{ name: "perf", description: "Performance" }] },
    }, false],
  ] as const)("keeps prompts, tools, and storage consistent: %s", async (name, config, globalEnabled) => {
    await fs.writeFile(path.join(configDir, "agent-memory.json"), JSON.stringify(config));
    const store = createMemoryStore(directory);
    await store.setBlock("global", "human", "GLOBAL_ONLY_FIXTURE");
    await store.setBlock("project", "human", "PROJECT_ONLY_FIXTURE");
    const globalPath = path.join(configDir, "memory", "human.md");
    const original = await fs.readFile(globalPath, "utf-8");

    const { ctx, hooks, tools } = createFakeContext(directory);
    await pluginDefinition.setup(ctx);

    const contextHook = hooks.find((h) => h.name === "context");
    expect(contextHook).toBeDefined();
    const event = createEvent(["provider header", "existing instructions"]);
    await contextHook!.callback(event);

    expect(event.system[0]!.text).toBe("provider header");
    expect(event.system[2]!.text).toBe("existing instructions");
    const prompt = event.system[1]!.text;
    expect(prompt).toContain("PROJECT_ONLY_FIXTURE");
    expect(prompt.includes("GLOBAL_ONLY_FIXTURE")).toBe(globalEnabled);
    expect(prompt.includes("scope=global")).toBe(globalEnabled);
    expect(prompt.includes("Memory blocks have two scopes:")).toBe(globalEnabled);
    expect(prompt.includes("- global:")).toBe(globalEnabled);
    if (!globalEnabled) {
      expect(prompt).toContain("Only project-scoped memory is available");
      await expect(fs.access(path.join(configDir, "memory", "persona.md"))).rejects.toThrow();
    }

    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.has("journal_write")).toBe(name === "journal enabled");
    if (name === "journal enabled") {
      expect(event.system[3]!.text).toContain("Performance");
    }
    for (const toolName of ["memory_list", "memory_set", "memory_replace"]) {
      const tool = byName.get(toolName)!;
      const scope = tool.input.properties.scope as { enum: string[] };
      expect(scope.enum.includes("global")).toBe(globalEnabled);
      expect(scope.enum.includes("project")).toBe(true);
      expect(scope.enum.includes("all")).toBe(toolName === "memory_list");
    }

    const listed = await byName.get("memory_list")!.execute({}, toolCtx);
    expect(textContent(listed)).toContain("project:human");
    expect(textContent(listed).includes("global:human")).toBe(globalEnabled);

    await byName.get("memory_set")!.execute({ label: "human", value: "Updated project" }, toolCtx);
    await byName.get("memory_replace")!.execute({ label: "human", oldText: "Updated", newText: "Revised" }, toolCtx);
    expect((await store.getBlock("project", "human")).value).toBe("Revised project");
    if (!globalEnabled) {
      await expect(byName.get("memory_set")!.execute({ scope: "global", label: "human", value: "wrong" }, toolCtx))
        .rejects.toThrow("Global memory scope is disabled");
      await expect(byName.get("memory_replace")!.execute({ scope: "global", label: "human", oldText: "GLOBAL", newText: "wrong" }, toolCtx))
        .rejects.toThrow("Global memory scope is disabled");
    }
    expect(await fs.readFile(globalPath, "utf-8")).toBe(original);
  });

  test("malformed config uses defaults with a console warning", async () => {
    await fs.writeFile(
      path.join(configDir, "agent-memory.json"),
      '{"memory": {"disable_global": true}',
    );
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { ctx, tools } = createFakeContext(directory);
      await pluginDefinition.setup(ctx);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("global memory enabled"),
      );
      const byName = new Map(tools.map((t) => [t.name, t]));
      const listed = await byName.get("memory_list")!.execute({}, toolCtx);
      expect(textContent(listed)).toContain("global:human");
      expect(textContent(listed)).toContain("project:project");
      const scope = byName.get("memory_set")!.input.properties.scope as { enum: string[] };
      expect(scope.enum.includes("global")).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("invalid memory settings stop initialization before seeding", async () => {
    await fs.writeFile(
      path.join(configDir, "agent-memory.json"),
      JSON.stringify({ memory: { disable_global: "true" } }),
    );
    const { ctx } = createFakeContext(directory);
    await expect(pluginDefinition.setup(ctx)).rejects.toThrow("agent-memory.json");
    await expect(fs.access(path.join(configDir, "memory"))).rejects.toThrow();
    await expect(fs.access(path.join(directory, ".opencode", "memory"))).rejects.toThrow();
  });
});
