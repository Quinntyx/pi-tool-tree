# pi-tool-tree

Claude-style tool call tree rendering for [pi](https://github.com/earendil-works/pi-mono).

Thinking and every tool call render as compact tree rows. Tool calls across all
assistant turns in one agent run form a single tree, and successful output collapses away:

```
● refactor session-state module        ← assistant text (untouched)
 ╭─ Thinking... 2.4s
 ├─ ✓ read src/session/state.ts · 0.3s
 ├─ ✓ grep /setLoading/ in src/ → 14 matches · 0.6s
 ╰─ ✗ bash npm test → exit 1 · 3.1s
```

- A whole agent run costs **one blank line + N tool lines** (previously each
  tool row was boxed separately with padding above and below).
- Result status and elapsed time are inlined (`→ 14 matches · 0.6s`).
- Thinking renders as `Thinking...` with a live streamed duration that freezes on `thinking_end`.
- The thinking transform is display-only; original reasoning remains unchanged in session/model context.
- `ctrl+o` expands built-in results and restores custom tools' original renderers.
- Errors punch through with a red `✗` even when collapsed.

## Install

Add the git package to Pi's `settings.json`:

```json
{
  "packages": ["git:git.quinntyx.dev/quinntyx/pi-tool-tree"],
  "hideThinkingBlock": false
}
```

The package declares `"pi": { "extensions": ["./index.ts"] }`.
It embeds `pi-hashline-edit@0.8.3` and registers its `read`, `edit`, and `grep` tools
through the tree renderer. Remove any separate `npm:pi-hashline-edit` package entry
to avoid duplicate tool registrations.

## Repository layout

Bare repo + per-branch worktrees:

```
pi-tool-tree/
├── .git      ← bare repo
└── main/     ← main branch worktree (the extension itself)
```

Create a feature worktree with:

```bash
cd ~/docs/src/pi-tool-tree
git worktree add <name> -b <branch> main
```

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Entry point: wraps built-ins/hashline tools, thinking, and run lifecycle |
| `registry.ts` | Shared tool-call state (globalThis-symbol keyed, so all module instances share it) |
| `render.ts` | Tree rendering; the first call draws the run, later call rows collapse to zero lines |
| `summarize.ts` | Per-tool one-line call summaries and result suffixes |
| `with-tool-tree.ts` | `withToolTree()` opt-in helper for third-party plugin tools |

## Supporting custom tools from other plugins

pi resolves tools **first registration wins** (in extension load order) and
uses the same definition for both execution and rendering. There is no public
API to fetch another extension's definition, so pi-tool-tree cannot
transparently re-wrap tools it doesn't register.

Instead, plugins opt in with one line:

```ts
import { withToolTree } from "<path-to>/pi-tool-tree/index.ts";

pi.registerTool(withToolTree(myToolDefinition, {
  summarizeCall: (args) => `${args.query}`,
  summarizeResult: (result, isError) => isError ? undefined : `${result.details.count} items`,
}));
```

- Execution is untouched; only rendering is taken over.
- The tool's original `renderCall`/`renderResult` stay available behind
  `ctrl+o` (disable with `keepExpandedRendering: false`).
- Works regardless of load order (the helper wraps the definition directly).
- Sets `renderShell: "self"`, which drops the default padded background box.

## How it works

- Tree row components read the shared registry on every TUI render pass, so
  statuses, suffixes, and tree glyphs update without explicit invalidation.
- The registry is fed from `agent_start`/`agent_settled`, assistant messages, and
  tool execution events. Calls append in assistant source order across every turn in
  the run; restored sessions rebuild run boundaries from user-message entries.
- Collapsed rows render zero-height output; pi hides rows whose renderers
  produce no lines, which is what merges a batch into one block.
