# pi-tool-tree

Claude-style live agent-run trees for [Pi](https://github.com/earendil-works/pi-mono).

```text
╭─ Thought for 2.4s
├─ ✓ read src/session/state.ts · 0.3s
├─ ✓ edit src/session/state.ts · 0.6s
╰─ … bash npm test · 1.8s
│  PASS src/session.test.ts
│  12 tests passed
```

## Behavior

- Creates one TUI-only transcript entry for each agent run.
- Streams the current thinking tokens under `Thinking... <duration>`.
- Freezes the duration at `thinking_end`.
- Keeps the newest thinking content visible until another thinking block starts.
- Collapses prior thinking to `Thought for <duration>`.
- Streams the active tool's partial output underneath its branch.
- Collapses completed tool details when the next activity starts or the run settles.
- `ctrl+o` expands settled thinking and tool output.
- Uses subdued rounded connectors with spaced statuses: `╭─ ✓`, `├─ …`, `╰─ ✗`.
- Uses Pi TUI's `visibleWidth()` and `truncateToWidth()` on every custom-rendered line.

Thinking and tool-result changes are display-only. Original messages and tool results remain unchanged in session/model context.

## Install

```json
{
  "packages": ["git:git.quinntyx.dev/quinntyx/pi-tool-tree"],
  "hideThinkingBlock": false
}
```

The package embeds `pi-hashline-edit@0.8.3` and registers its `read`, `edit`, and `grep` implementations through the tree renderer. Remove any separate `npm:pi-hashline-edit` package entry to avoid duplicate tool registrations.

## Custom tools

Tools from other plugins opt in with `withToolTree()`:

```ts
import { withToolTree } from "<path-to>/pi-tool-tree/index.ts";

pi.registerTool(withToolTree(myToolDefinition, {
  summarizeCall: (args) => args.query,
  summarizeResult: (result, isError) =>
    isError ? undefined : `${result.details.count} items`,
}));
```

Execution is untouched. Original custom renderers are captured for nested live/expanded detail output.

## Architecture

| File | Purpose |
|------|---------|
| `index.ts` | Tool composition, run-entry registration, and lifecycle events |
| `registry.ts` | Shared live run/thinking/tool state |
| `render.ts` | Width-safe run component and hidden source-row renderers |
| `summarize.ts` | Tool summaries and elapsed-time formatting |
| `with-tool-tree.ts` | Opt-in helper for custom plugin tools |

The repository uses a bare repo plus `main/` worktree layout under `~/docs/src/pi-tool-tree`.
