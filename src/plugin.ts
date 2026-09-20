import { Plugin } from "@opencode/plugin";

import {
  buildJournalSystemNote,
  createJournalStore,
  loadConfig,
} from "./journal";
import { createMemoryStore } from "./memory";
import { renderMemoryBlocks } from "./prompt";
import {
  JournalRead,
  JournalSearch,
  JournalWrite,
  MemoryList,
  MemoryReplace,
  MemorySet,
} from "./tools";
import type { JournalContext, MemoryToolDefinition } from "./tools";

export default Plugin.define({
  id: "opencode-agent-memory",
  async setup(ctx) {
    const directory = ctx.location.directory;

    const config = await loadConfig(undefined, (message) => {
      console.warn(`[agent-memory] ${message}`);
    });
    const disableGlobal = config.memory?.disable_global === true;

    const store = createMemoryStore(directory, { disableGlobal });
    await store.ensureSeed();

    // Journal: opt-in via ~/.config/opencode/agent-memory.json
    const journalEnabled = config.journal?.enabled === true;

    // Mutable state updated by the session "context" hook
    const journalCtx: JournalContext = {
      directory,
      model: "",
      provider: "",
    };

    let journalSystemNote = "";
    const journalTools: MemoryToolDefinition[] = [];

    if (journalEnabled) {
      const journalStore = createJournalStore();
      journalTools.push(
        JournalWrite(journalStore, journalCtx),
        JournalRead(journalStore),
        JournalSearch(journalStore),
      );
      journalSystemNote = buildJournalSystemNote(config.journal?.tags);
    }

    // One hook covers both V1 behaviors: capturing the resolved model for
    // journal metadata, and injecting rendered memory blocks into the system
    // prompt. All async loading happens before registration; the callback
    // itself stays cheap and replayable.
    await ctx.session.hook("context", async (event) => {
      journalCtx.model = event.model.id;
      journalCtx.provider = event.model.providerID;

      const blocks = await store.listBlocks("all");
      const xml = renderMemoryBlocks(blocks, { disableGlobal });
      if (!xml) return;

      // Insert early (right after provider header) for salience.
      // OpenCode will re-join system chunks to preserve caching.
      const insertAt = event.system.length > 0 ? 1 : 0;
      event.system.splice(insertAt, 0, { type: "text", text: xml });

      // Append journal instructions at the end (preserves memory block cache)
      if (journalSystemNote) {
        event.system.push({ type: "text", text: journalSystemNote });
      }
    });

    const tools: MemoryToolDefinition[] = [
      MemoryList(store, { disableGlobal }),
      MemorySet(store, { disableGlobal }),
      MemoryReplace(store, { disableGlobal }),
      ...journalTools,
    ];

    await ctx.tool.transform((editor) => {
      for (const tool of tools) {
        editor.add(tool);
      }
    });
  },
});
