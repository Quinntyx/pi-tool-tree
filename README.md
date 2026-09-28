# pi-tool-tree

> [!NOTE]
> **Upstream:** the canonical, community-facing home of this project is [github.com/Quinntyx/pi-tool-tree](https://github.com/Quinntyx/pi-tool-tree). This git.quinntyx.dev copy is the author's development fork — day-to-day churn lands here and is PR'd to GitHub on release. Install instructions below point at GitHub.

> [!WARNING]
> **Under construction.** This README is being rewritten for the 2.x line — treat the sections below as historical reference until then.

> [!IMPORTANT]
> **Experimental plugin.** Expect rendering bugs and breaking changes between versions.

> [!NOTE]
> **Attribution.** This project is a fork of
> [`pi-claude-code-ui`](https://www.npmjs.com/package/pi-claude-code-ui)
> (formerly `pi-claude-style-tools`) — the Claude Code-style tool rendering for
> pi. The canonical copy of this fork lives at
> [github.com/Quinntyx/pi-tool-tree](https://github.com/Quinntyx/pi-tool-tree);
> [git.quinntyx.dev/quinntyx/pi-tool-tree](https://git.quinntyx.dev/quinntyx/pi-tool-tree)
> is the author's development fork where day-to-day work happens first.

Claude Code inspired tool rendering for Pi — Shiki-powered diffs, status dots, branch connectors, file icons, and configurable output modes.

## Features

- **Compact built-in tool rendering** for `read`, `bash`, `grep`, `find`, `ls`, `edit`, and `write`
- **Claude-style OpenAI tool rendering** for `apply_patch` plus common Pi/OpenAI-style tools like `webfetch`, `web_search`, `fetch_content`, task tools, and context tools
- **`apply_patch` diff previews** that render parsed file patches in the call phase, similar to `edit`/`write`
- **Always-visible edit/write previews** below each mutation row, including pending write previews and complete multi-edit hunk blocks with surrounding context, with automatic split left/right layout when space allows and unified layout on narrow terminals
- **Diff stat bar** with colored add/remove summary and hunk metadata
- **Progressive collapsed diff hints** that shorten on narrow terminals
- **Live-only thinking** (default) — thinking streams inside its tree child; finished thinking collapses to a one-line `Thought for Xs` row (`/cc-tools thinking full` restores always-expanded, `Ctrl+T` still expands thinking)
- **MCP-aware rendering** with hidden, summary, and preview modes
- **Configurable output modes** for read, search, bash, and MCP results
- **Live running previews** that show a few output lines for active tool calls (latest lines for bash), persisting until the next tool/text activity
- **Subagent completion notifications** restyled to match the same Claude-style tool rows
- **RTK rewrite integration** that folds rewrite notices into the bash tool row with a muted `(RTK)` badge and expanded-only rewrite details
- **Transparent tool backgrounds** in `transparent` or `border` mode
- **Theme-adaptive palette** — borders, branch connectors, dim text, and diff backgrounds automatically follow the active pi theme (set `themeAdaptive: false` to keep the fixed Claude-style palette)
- **Light Ghostty-sync themes** — edit/write diffs use `github-light` highlighting and light-tinted diff rows; tool pending dots use softer chrome colors
- **Transparent edit/write diffs** with universal red/green diff colors
- **Unified activity trees** with a distinct child for every tool call and thinking run, including repeated calls. Assistant prose and user messages remain outside the tree (set `groupToolCalls: false` to disable).
- **Native custom-tool animations** (including Code Execution) remain visible while running, collapse on completion, and expand again with `Ctrl+O`.
- **No horizontal tool rules**, including when older settings select `border` or `outlines`.
- **Quieter layout**: short `├` / `╰` connectors, assistant prose left in pi's own flush-left Markdown rendering, blank lines between transcript blocks, and default Markdown bullets. Settled calls use green `✓` or red `!`; running calls breathe a sized light (`● → • → · → · → •`) — group headers keep a steady `●`, since their label already shimmers. `pendingIndicator` also offers `spinner` (braille `⠃⠉⠘⠰⢠⣀⡄⠆`) and `dot` (classic blinking `●`).
- **Extra detail toggle** with `Ctrl+Shift+O`, increasing expanded preview caps without making the default view heavy
- **Global border patch** for all tool rows, including unknown/custom tools
- **Activity API for other extensions** — ask what the session is doing (phase, current activity label, calls running now) and what it has done (work time, runs, turns, call counts, per-tool and per-label breakdowns), or subscribe to changes. See the [API](#api) section and [API.md](./API.md).

## Configuration

Settings are read from the project (`.pi/settings.json` in the working directory) and from pi's global settings for the current run: `$PI_CODING_AGENT_DIR/settings.json` when set (profile launchers like `ppi` point it at the active profile), falling back to the legacy `~/.pi/settings.json` at lower precedence. `/cc-tools` toggles persist into the active global file:

```json
{
  "toolBackground": "border",
  "readOutputMode": "preview",
  "searchOutputMode": "preview",
  "mcpOutputMode": "preview",
  "previewLines": 8,
  "expandedPreviewMaxLines": 4000,
  "extraExpandedPreviewMaxLines": 12000,
  "extraToolOutputExpanded": false,
  "groupToolCalls": true,
  "activityGroups": true,
  "toolActivityParam": true,
  "thinkingMode": "live",
  "bashOutputMode": "opencode",
  "bashCollapsedLines": 10,
  "bashCommandPreviewLines": 8,
  "liveToolPreview": true,
  "liveToolPreviewLines": 5,
  "diffViewMode": "auto",
  "diffSplitMinWidth": 132,
  "diffCollapsedLines": 24,
  "themeAdaptive": true,
  "diffTheme": "github-dark"
}
```

### Theme integration

When `themeAdaptive` is `true` (default), the following colors are derived from the active pi theme on every render and re-derived whenever the theme changes:

| Element | Derived from |
|---------|--------------|
| Tool rules, code fences | `dim` → `muted` → `borderMuted` → `thinkingText` |
| Branch connectors (`├`, `╰`, `│`) | Activity trees and paragraph dots use light gray on light themes, dim gray on dark themes; explicit `/cc-tools branch` settings still override this |
| "✻ Agent took Ns" line (final message only, with cumulative active-work total + the run's turn count) | `muted` |
| Expanded thinking-block text and `∴` marker | `muted` |
| Diff add/remove accents | `toolDiffAdded` / `toolDiffRemoved` |
| Diff background tints | mixed against `toolSuccessBg` base |

User-supplied `diffTheme` presets and `diffColors` overrides always win over theme-derived defaults. File-type icons (e.g. `ts`, `py`, `rs`) keep their language-identity colors and are not theme-derived.

Set `themeAdaptive: false` to keep the original fixed Claude-style palette regardless of the active pi theme.

On `/resume`, `/new`, or `/fork`, tool chrome is rebound from the **current** pi theme (no coupling to Ghostty or other theme extensions). If you use Ghostty sync, listing it **above** this extension in `settings.json` is recommended so `setTheme` runs before chrome rebind.

#### Toggle at runtime with `/cc-theme`

```text
/cc-theme           # show current setting + theme name
/cc-theme status    # show current setting + color preview
/cc-theme on        # follow pi theme
/cc-theme off       # keep fixed Claude palette
/cc-theme toggle    # flip the current value
```

The selection is persisted to `~/.pi/settings.json` and applied to the next rendered tool row. No restart required.

### Tool background modes

| Value | Behavior |
|-------|----------|
| `default` | Standard Pi tool backgrounds |
| `transparent` | Transparent tool backgrounds |
| `border` | Transparent backgrounds (legacy alias; no horizontal rules) |

Use `/cc-tools` to control tool UI at runtime:

```text
/cc-tools status          # show style, grouping, and extra-detail state
/cc-tools outlines        # tool style: outlines, transparent, or default
/cc-tools group toggle    # toggle grouped adjacent/concurrent tool calls
/cc-tools group off       # disable grouping (also ungroups current grouped rows)
/cc-tools thinking live   # default: only the streaming thinking expands; finished ones collapse
/cc-tools thinking full   # always render thinking expanded, like stock pi
                          # (Ctrl+T / `hideThinkingBlock` hides thinking entirely: nothing streams)
/cc-tools detail toggle   # same mode as Ctrl+Shift+O
/cc-tools activity toggle # add/remove the model's activity label on tool calls
/cc-tools shimmer toggle  # sweep a highlight across a running group's label
/cc-tools pending spinner # per-call pending light: circle-breathe (default), braille spinner, or dot
```

### Activity labels

Adjacent tool calls are grouped into phases named by the model on each call:

```text
 ● implementing 3 calls · 4.2s
 ├ ✓ edit  src/index.ts
 ├ ✓ bash  bun test
 ╰ ✓ edit  src/utils.ts
```

The seven tools this package owns (`read`, `bash`, `grep`, `find`, `ls`, `write`,
`edit`) declare an `activity` param, so the label usually arrives with every call.
It is stripped again before the tool executes, and the recorded message keeps
exactly the arguments the model sent. Calls from tools that do not opt in (MCP,
other plugins) inherit the previous group's label instead of starting a new group;
a group with nothing to inherit (the first group of a run, or a tool that never
declared `activity`) falls back to the default label `working` instead of showing a
bare `N calls` header.

Only tool calls are counted, so a thinking row never inflates `N calls`. A run
without any tool call (a trailing thought, for example) prints its rows without a
header, and blank lines separate groups from the prose between them. The group
duration sums tool time **plus the thinking time inside the group**, and it **ticks
live while the group runs** (freezing at its final value once the last call
settles), so a phase that reasoned 19s before a fast tool reads `· 19s`, not `· <1s`.

While a group is still running, its label shimmers: a highlight band sweeps across
the word (the Claude Code / ChatGPT "working" effect), painted in the active theme's
color for the **current thinking level** — `thinkingMinimal` through `thinkingMax`, the
same palette pi uses for the editor border. So `/thinking`, `Shift+Tab`, and model
switches retint a running sweep as they happen, and a live label doubles as a readout of
how hard the model is being asked to think. Pi's muted levels ("off" is usually a
surface tone) are stepped toward the panel's emphasis color when they would otherwise be
invisible, and a theme with no color for the level falls back to its accent. The label
settles to a constant color once the last call finishes. The transcript arms its own
repaint while a group is in flight — 80ms with the shimmer on, 500ms for a bare live
timer — because grouped rows bypass pi's native tool renderer, which is what the ● blink
normally rides on. Turn it off with `/cc-tools shimmer off` or
`"activityShimmer": false`.

Pending lights spin on the same wall-clock frame index (from `SPINNER_FRAMES`), so
running call rows agree on a frame. Agent-family calls keep their size-breathe light,
which stays on its own 500ms beat. The group header itself keeps a steady ● instead:
its label already animates, so the sweep is the "still working" signal there.

Only tool calls are counted, so a thinking row never inflates `N calls`. A run
without any tool call (a trailing thought, for example) prints its rows without a
header, and blank lines separate groups from the prose between them.

#### Plugin integration (opt-in)

Tools registered by other extensions are not wrapped automatically:
`pi.getAllTools()` exposes no `execute`, so they cannot be re-registered from the
outside. A plugin opts in by wrapping its own definition before registering it —
the integration is published on `globalThis` under
`Symbol.for("pi-tool-tree:activity-api")`:

```ts
const activity = (globalThis as any)[Symbol.for("pi-tool-tree:activity-api")];
const tool = buildMyTool();
pi.registerTool(activity?.wrapTool ? activity.wrapTool(tool) : tool);
```

`wrapTool(tool)` adds `activity` to the schema, defaults a missing label to
`working` in `prepareArguments`, and strips the label from the arguments your
`execute` receives. It is a no-op when `toolActivityParam` is `false`, so plugins
can call it unconditionally. Toggling the setting applies to the core tools
immediately and to plugin tools the next time they register. The same object also
answers the activity queries — see [API.md](./API.md).
### Output modes

| Setting | Values | Default |
|---------|--------|---------|
| `readOutputMode` | `hidden`, `summary`, `preview` | `preview` |
| `searchOutputMode` | `hidden`, `count`, `preview` | `preview` |
| `mcpOutputMode` | `hidden`, `summary`, `preview` | `preview` |
| `bashOutputMode` | `opencode`, `summary`, `preview` | `opencode` |

### Display settings

| Setting | Default | Description |
|---------|---------|-------------|
| `previewLines` | `8` | Lines shown in collapsed preview mode |
| `expandedPreviewMaxLines` | `4000` | Max lines when expanded with Ctrl+O |
| `extraExpandedPreviewMaxLines` | `12000` | Max lines after Ctrl+Shift+O extra-detail mode |
| `extraToolOutputExpanded` | `false` | Start with Ctrl+Shift+O extra-detail mode enabled |
| `groupToolCalls` | `true` | Group adjacent thinking/tool activity with one child per call |
| `activityGroups` | `true` | Label each group with the model-supplied `activity` word |
| `pendingIndicator` | `breathe` | Pending light for individual tool calls: `breathe` (sized `● → • → · → · → •`, 500ms steps), `spinner` (braille `⠃⠉⠘⠰⢠⣀⡄⠆` at 80ms), or `dot` (classic blinking `●`). Group headers keep a steady `●` because their label already shimmers |
| `activityShimmer` | `true` | Sweep a highlight across a running group's label in the theme color of the current thinking level (`thinkingMinimal`…`thinkingMax`, falling back to the theme's accent), following `/thinking` and `Shift+Tab` live; constant color once the group settles. Also drives the ~80ms repaint of the live group timer |
| `toolActivityParam` | `true` | Add the `activity` param to the tools this package owns (optional; a missing label defaults to `working`) |
| `thinkingMode` | `live` | `live` = only streaming thinking expands (finished collapse to `Thought for Xs`); `full` = always expanded. Pi's `hideThinkingBlock` (Ctrl+T) wins over both: hidden thinking never streams a body. |
| `bashCollapsedLines` | `10` | Lines for collapsed bash output |
| `bashCommandPreviewLines` | `8` | Verbatim script lines shown while bash runs or after failure; `0` disables them |
| `liveToolPreview` | `true` | Show a small live output preview while tools are still running |
| `liveToolPreviewLines` | `5` | Lines shown in the collapsed live preview |
| `diffViewMode` | `auto` | `auto` uses split left/right previews at `diffSplitMinWidth` and unified previews below it; `split` and `unified` force a layout when physically possible |
| `diffSplitMinWidth` | `132` | Minimum available width where `auto` may use a split preview (long visible lines still select unified mode) |
| `diffCollapsedLines` | `24` | Diff lines before collapsing |

## API

Other extensions can ask what the session is doing and what it has done, without
scraping the transcript or hooking the renderer. The API is published on
`globalThis` under `Symbol.for("pi-tool-tree:api")` (and under the legacy
`Symbol.for("pi-tool-tree:activity-api")`, which resolves to the same object):

```ts
const api = (globalThis as any)[Symbol.for("pi-tool-tree:api")];
if (api?.getActivity) {
	const { phase, label, isThinking, isRunningTool, run } = api.getActivity();
	// phase: "idle" | "waiting" | "thinking" | "responding" | "tool"
	// label: "implementing"   run: { elapsedMs, turns, toolCalls, toolMs, … }
}
```

| Method | Returns |
|--------|---------|
| `getActivity()` | Live snapshot: phase (idle / waiting / thinking / responding / tool), the current activity label and how long it has been current, calls running right now, and the current run's counters |
| `getStats()` | Cumulative session statistics: completed work time, runs, turns, tool calls and failures, tool and reasoning time, plus per-tool and per-label breakdowns (resumed history included) |
| `subscribe(listener)` | Change notifications (`run-start`, `turn-start`, `label-change`, `thinking-start/end`, `stream-start/end`, `tool-start/end`, `run-end`) with the resulting snapshot; returns an unsubscribe function |
| `formatDuration(ms)` | The transcript's own duration formatting (`<1s`, `12s`, `3m 05s`, `1h 02m`) |
| `wrapTool(tool)` | The opt-in `activity` param hook for tools another extension registers (see [Plugin integration](#plugin-integration-opt-in)) |

State is fed by pi's own events rather than by the renderer, so it is correct in
hosts that never paint the grouped rows (RPC, headless, tests), and durations are
measured at the moment you ask — a status line can poll `getActivity()` on its own
repaint cadence. Snapshots are copies, listeners that throw are ignored, and
subscriptions do not survive a reload.

See [API.md](./API.md) for the full reference: every field, the change table,
what counts as a run/turn/call, live-versus-settled semantics, the resume-seeding
rules, and copy-pasteable TypeScript types.

## Notes

This package targets recent Pi versions where tool renderers use:

- `renderCall(args, theme, context)`
- `renderResult(result, { expanded, isPartial }, theme, context)`

Unknown/custom tools do not have a public global renderer hook in Pi, so this package patches container rendering to add top/bottom borders for all tool executions in border mode.

## Credits

This project builds upon and was inspired by the excellent work of:

- **[@heyhuynhgiabuu/pi-pretty](https://github.com/buddingnewinsights/pi-pretty)** by [huynhgiabuu](https://github.com/buddingnewinsights) — Pretty terminal output with syntax-highlighted file reads, colored bash output, and tree-view directory listings
- **[@heyhuynhgiabuu/pi-diff](https://github.com/buddingnewinsights/pi-diff)** by [huynhgiabuu](https://github.com/buddingnewinsights) — Shiki-powered terminal diff renderer with word-level diffs in split and unified views
- **[pi-tool-display](https://github.com/MasuRii/pi-tool-display)** by [MasuRii](https://github.com/MasuRii) — Compact tool call rendering, diff visualization, and output truncation
