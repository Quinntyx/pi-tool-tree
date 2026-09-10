# pi-claude-code-ui

This fork leaves user-message styling, the prompt editor, and footer/status UI to
Pi or other extensions such as `pi-opencode-prompt`. The upstream user-message
patch and spinner/working-message extension have been removed. After updating,
restart Pi fully: `/reload` cannot undo previously installed prototype patches.

> [!IMPORTANT]
> **Package renamed in 1.0.69.** This project is now published as [`pi-claude-code-ui`](https://www.npmjs.com/package/pi-claude-code-ui) (was `pi-claude-style-tools`).
>
> Install / migrate:
> ```bash
> pi install npm:pi-claude-code-ui
> # or
> npm i pi-claude-code-ui
> ```
> See [CHANGELOG 1.0.69](./CHANGELOG.md#1069--2026-07-17) for the full release notes (status dots, bare branch connectors, and more).

Claude Code inspired tool rendering for Pi — Shiki-powered diffs, status dots, branch connectors, file icons, and configurable output modes.

## Features

- **Compact built-in tool rendering** for `read`, `bash`, `grep`, `find`, `ls`, `edit`, and `write`
- **Claude-style OpenAI tool rendering** for `apply_patch` plus common Pi/OpenAI-style tools like `webfetch`, `web_search`, `fetch_content`, task tools, and context tools
- **`apply_patch` diff previews** that render parsed file patches in the call phase, similar to `edit`/`write`
- **Adaptive edit/write diffs** with split or unified layouts, syntax highlighting, and inline word-level emphasis
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
- **Quieter layout**: short `├` / `╰` connectors, assistant prose left in pi's own flush-left Markdown rendering, blank lines between transcript blocks, and default Markdown bullets. Settled calls use green `✓` or red `!`; running indicators remain animated.
- **Extra detail toggle** with `Ctrl+Shift+O`, increasing expanded preview caps without making the default view heavy
- **Global border patch** for all tool rows, including unknown/custom tools

## Configuration

Set in `.pi/settings.json` or `~/.pi/settings.json`:

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
`edit`) declare a required `activity` param, so the label arrives with every call.
It is stripped again before the tool executes, and the recorded message keeps
exactly the arguments the model sent. Calls from tools that do not opt in (MCP,
other plugins) inherit the previous group's label instead of starting a new group.

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
immediately and to plugin tools the next time they register.
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
| `toolActivityParam` | `true` | Add the required `activity` param to the tools this package owns |
| `thinkingMode` | `live` | `live` = only streaming thinking expands (finished collapse to `Thought for Xs`); `full` = always expanded. Pi's `hideThinkingBlock` (Ctrl+T) wins over both: hidden thinking never streams a body. |
| `bashCollapsedLines` | `10` | Lines for collapsed bash output |
| `bashCommandPreviewLines` | `8` | Verbatim script lines shown while bash runs or after failure; `0` disables them |
| `liveToolPreview` | `true` | Show a small live output preview while tools are still running |
| `liveToolPreviewLines` | `5` | Lines shown in the collapsed live preview |
| `diffCollapsedLines` | `24` | Diff lines before collapsing |

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
