import type { Info, ToolContext } from "@opencode/plugin/promise/tool";

import type { JournalStore } from "./journal";
import type { MemoryScope, MemoryStore } from "./memory";

/**
 * V2-shaped tool definitions, typed directly against the plugin SDK's
 * promise-flavored `Info` type so `editor.add(tool)` in plugin.ts typechecks
 * with no casts.
 *
 * `input` is a plain JSON Schema object: `Tool.ValueSchema` accepts effect's
 * `JsonSchema.JsonSchema`, which is an open record (`{ [x: string]: unknown }`)
 * with no branding, so object literals are assignable as-is. With a plain
 * object as the input schema the SDK types execute's first parameter as
 * `unknown`; each `execute` narrows it once via the `asArgs` helper below.
 * Execute's second parameter is the SDK's `ToolContext`, which really does
 * expose `sessionID` and `agent` (as branded `Session.ID` / `Agent.ID`
 * strings). `execute` returns `{ content }`, which satisfies `Tool.Result`.
 */

export type JsonSchemaObject = {
  readonly type: "object";
  readonly properties: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
};

export type MemoryToolDefinition = Info<JsonSchemaObject, undefined>;

function parseTags(rawTags: string | undefined): string[] | undefined {
  return rawTags
    ? rawTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined;
}

/**
 * With a plain JSON Schema `input` (no Effect codec / StandardSchema to infer
 * from), the SDK types execute's first parameter as `unknown`. Every execute
 * narrows it once through this helper — the only cast needed in this file.
 */
function asArgs(input: unknown): Record<string, unknown> {
  return input as Record<string, unknown>;
}

export type MemoryToolOptions = {
  disableGlobal?: boolean;
};

function scopeEnum(values: readonly string[]) {
  return {
    type: "string",
    enum: [...values],
  };
}

function str(description?: string) {
  return description ? { type: "string", description } : { type: "string" };
}

function positiveInt(description?: string) {
  return description
    ? { type: "integer", exclusiveMinimum: 0, description }
    : { type: "integer", exclusiveMinimum: 0 };
}

export function MemoryList(store: MemoryStore, opts?: MemoryToolOptions): MemoryToolDefinition {
  const disableGlobal = opts?.disableGlobal === true;
  const scopeValues = disableGlobal
    ? (["all", "project"] as const)
    : (["all", "global", "project"] as const);

  return {
    name: "memory_list",
    description: "List available memory blocks (labels, descriptions, sizes).",
    input: {
      type: "object",
      properties: {
        scope: scopeEnum(scopeValues),
      },
      additionalProperties: false,
    },
    async execute(input) {
      const args = asArgs(input);
      // Default to "all" for list (show everything)
      const scope = ((args.scope as string | undefined) ?? "all") as MemoryScope | "all";
      const blocks = await store.listBlocks(scope);
      if (blocks.length === 0) {
        return { content: "No memory blocks found." };
      }

      return {
        content: blocks
          .map(
            (b) =>
              `${b.scope}:${b.label}\n  read_only=${b.readOnly} chars=${b.value.length}/${b.limit}\n  ${b.description}`,
          )
          .join("\n\n"),
      };
    },
  };
}

export function MemorySet(store: MemoryStore, opts?: MemoryToolOptions): MemoryToolDefinition {
  const disableGlobal = opts?.disableGlobal === true;
  const scopeValues = disableGlobal
    ? (["project"] as const)
    : (["global", "project"] as const);

  return {
    name: "memory_set",
    description: "Create or update a memory block (full overwrite).",
    input: {
      type: "object",
      properties: {
        label: str(),
        scope: scopeEnum(scopeValues),
        value: str(),
        description: str(),
        limit: positiveInt(),
      },
      required: ["label", "value"],
      additionalProperties: false,
    },
    async execute(input) {
      const args = asArgs(input);
      // Default to "project" for mutations (safer default)
      const scope = ((args.scope as string | undefined) ?? "project") as MemoryScope;
      await store.setBlock(scope, args.label as string, args.value as string, {
        description: args.description as string | undefined,
        limit: args.limit as number | undefined,
      });
      return { content: `Updated memory block ${scope}:${args.label as string}.` };
    },
  };
}

export function MemoryReplace(store: MemoryStore, opts?: MemoryToolOptions): MemoryToolDefinition {
  const disableGlobal = opts?.disableGlobal === true;
  const scopeValues = disableGlobal
    ? (["project"] as const)
    : (["global", "project"] as const);

  return {
    name: "memory_replace",
    description: "Replace a substring within a memory block.",
    input: {
      type: "object",
      properties: {
        label: str(),
        scope: scopeEnum(scopeValues),
        oldText: str(),
        newText: str(),
      },
      required: ["label", "oldText", "newText"],
      additionalProperties: false,
    },
    async execute(input) {
      const args = asArgs(input);
      // Default to "project" for mutations (safer default)
      const scope = ((args.scope as string | undefined) ?? "project") as MemoryScope;
      await store.replaceInBlock(
        scope,
        args.label as string,
        args.oldText as string,
        args.newText as string,
      );
      return { content: `Updated memory block ${scope}:${args.label as string}.` };
    },
  };
}

export type JournalContext = {
  directory: string;
  model: string;
  provider: string;
};

export function JournalWrite(
  store: JournalStore,
  ctx: JournalContext,
): MemoryToolDefinition {
  return {
    name: "journal_write",
    description:
      "Write a new journal entry. Use this to capture insights, technical discoveries, " +
      "design decisions, observations, or reflections. Entries are append-only and cannot be edited. " +
      "Tags are optional comma-separated names, e.g. \"perf, debugging\".",
    input: {
      type: "object",
      properties: {
        title: str(),
        body: str(),
        tags: str(),
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
    async execute(input, toolCtx: ToolContext) {
      const args = asArgs(input);
      const tags = parseTags(args.tags as string | undefined);

      const entry = await store.write({
        title: args.title as string,
        body: args.body as string,
        project: ctx.directory,
        model: ctx.model,
        provider: ctx.provider,
        agent: toolCtx.agent,
        sessionId: toolCtx.sessionID,
        tags,
      });

      return {
        content: `Journal entry created: ${entry.id}\n  title: ${entry.title}\n  created: ${entry.created.toISOString()}`,
      };
    },
  };
}

export function JournalRead(store: JournalStore): MemoryToolDefinition {
  return {
    name: "journal_read",
    description:
      "Read a specific journal entry by its ID. Returns the full entry " +
      "including metadata and body.",
    input: {
      type: "object",
      properties: {
        id: str(),
      },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(input) {
      const args = asArgs(input);
      const entry = await store.read(args.id as string);

      const meta = [
        `title: ${entry.title}`,
        `created: ${entry.created.toISOString()}`,
        entry.project ? `project: ${entry.project}` : null,
        entry.model ? `model: ${entry.model}` : null,
        entry.provider ? `provider: ${entry.provider}` : null,
        entry.agent ? `agent: ${entry.agent}` : null,
        entry.sessionId ? `session: ${entry.sessionId}` : null,
        entry.tags.length > 0
          ? `tags: ${entry.tags.join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");

      return { content: `${meta}\n\n${entry.body}` };
    },
  };
}

export function JournalSearch(store: JournalStore): MemoryToolDefinition {
  return {
    name: "journal_search",
    description:
      "Search journal entries using semantic similarity. Returns matching entries " +
      "sorted by relevance. All filters are optional and combined with AND logic. " +
      "Use with no arguments to list recent entries. Use offset to paginate.",
    input: {
      type: "object",
      properties: {
        text: str(),
        project: str(),
        tags: str(),
        limit: positiveInt(),
        offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    async execute(input) {
      const args = asArgs(input);
      const tags = parseTags(args.tags as string | undefined);

      const result = await store.search({
        text: args.text as string | undefined,
        project: args.project as string | undefined,
        tags,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined,
      });

      if (result.entries.length === 0) {
        const tagsLine =
          result.allTags.length > 0
            ? `\nTags in use: ${result.allTags.join(", ")}`
            : "";
        return { content: `No journal entries found.${tagsLine}` };
      }

      const offset = (args.offset as number | undefined) ?? 0;
      const header = `Found ${result.total} entries (showing ${offset + 1}–${offset + result.entries.length}):`;
      const tagsLine =
        result.allTags.length > 0
          ? `\nTags in use: ${result.allTags.join(", ")}`
          : "";

      const lines = result.entries.map((e) => {
        const tagStr =
          e.tags.length > 0
            ? ` [${e.tags.join(", ")}]`
            : "";
        return `${e.id}\n  ${e.title}${tagStr}\n  ${e.created.toISOString()}`;
      });

      return { content: `${header}${tagsLine}\n\n${lines.join("\n\n")}` };
    },
  };
}
