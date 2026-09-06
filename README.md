# pi-tool-tree

Claude-style tool call tree rendering for [pi](https://github.com/earendil-works/pi-mono).

Every tool call renders as a **single terminal line**. Sibling tool calls from
one assistant message form a tree block, and successful output collapses away:

```
● refactor session-state module        ← assistant text (untouched)
 ╭─✓ read src/session/state.ts
 ├─✓ grep /setLoading/ in src/ → 14 matches
 ╰─✗ bash npm test → exit 1
```

- A whole parallel batch costs **one blank line + N lines** (previously each
  tool row was boxed with padding above and below).
- Result status is inlined (`→ 14 matches`, `exit 1`).
- `ctrl+o` expands built-ins to raw result output and restores custom tools' original renderers.
- Errors punch through with a red `✗` even when collapsed.

## Install

```bash
ln -s ~/docs/src/pi-tool-tree/main ~/.pi/agent/extensions/pi-tool-tree
```

(or copy / npm-publish later — the package declares `"pi": { "extensions": ["./index.ts"] }`.)

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
| `index.ts` | Entry point: wraps built-in tools, wires registry events |
| `registry.ts` | Shared tool-call state (globalThis-symbol keyed, so all module instances share it) |
| `render.ts` | Tree row rendering; the first sibling draws the whole group, later siblings collapse to zero lines |
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
- The registry is fed from `message_update`/`message_end` (sibling groups in
  assistant source order), `tool_execution_start`/`end` (running/error
  status), and rebuilt from session entries on `session_start` so restored
  sessions render collapsed trees too.
- Collapsed rows render zero-height output; pi hides rows whose renderers
  produce no lines, which is what merges a batch into one block.
