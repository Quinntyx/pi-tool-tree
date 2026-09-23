# Changelog

> [!IMPORTANT]
> **1.0.69 — package rename (permanent).** Canonical npm name is now [`pi-claude-code-ui`](https://www.npmjs.com/package/pi-claude-code-ui). `pi-claude-style-tools` is legacy and will not receive further releases. Install with `pi install npm:pi-claude-code-ui` or `npm i pi-claude-code-ui`.

## 1.0.80 — 2026-08-24

### Fixed

- **Scrub Magic Context tags at the terminal writer** — last-resort display filter at the `ProcessTerminal.write` choke point removes every complete `§N§` token from painted output, covering any surface the targeted render strips can't reach: mid-sentence tag references in ctx_reduce/system-reminder tool output, replayed history on resume, overlays, and search hits. Display only — session storage, LLM context, copy sources, and ANSI sequences are untouched, so plugin functionality is unaffected.

## 1.0.79 — 2026-08-23

### Fixed

- **Hide Magic Context tags in tool output** — tool result renderers now receive sanitized text, so transient `§N§` tags (including live-prefixed streaming chunks and queued ctx_reduce output replayed from history) no longer appear in tool rows. Storage is never mutated — result blocks are cloned only when a tag is present, so context management keeps its data. Also covers the `formatToolExecution` fallback path for renderer-less tools.

## 1.0.78 — 2026-08-22

### Fixed

- **Hide transient Magic Context tags** — dynamically filter Magic Context tags (like `§N§`) from all Markdown view components in the Terminal UI. This covers thinking blocks, user messages, assistant prose, and subagent frames, without mutating the underlying message text content or breaking LLM prompt tracking.

## 1.0.77 — 2026-08-21

### Fixed

- **Dynamic Turn Took lines** — the end line `✻ Turn took xs` is now rendered dynamically in the Terminal UI instead of being baked into the message text content. This avoids polluting saved session databases and other UIs (like VSCode or web interfaces), and prevents interference with tools like TPS counters that read the message text.

## 1.0.76 — 2026-08-07

### Fixed

- **Hide transient context tags** — hide transient context tags in streaming prose.

## Unreleased

### Fixed

- **Mutation previews no longer collapse while they rebuild** — a diff preview is rendered in the background (Shiki highlighting is async) and a one- or two-line placeholder stands in while it does. That placeholder replaced a diff that was already on screen, so a row could shrink from dozens of lines to its red/green stat line, reflowing the transcript under the reader and making scrolling jump. A row now keeps the diff it is already showing until the new one is ready, a failed build leaves the previous body alone instead of shrinking the row to its summary, and the resize reflow frame keeps the row's shape (its previous lines, clipped to the new width) instead of collapsing to the tool heading. A superseded build also can no longer land last: the pending-build guard compared the row's key, which carried the diff width, so a width change mid-render discarded the result and left the row on its placeholder.
- **Diff previews take their final height on the first frame** — the unhighlighted body is now rendered synchronously and published immediately, then the Shiki-highlighted body replaces it. Both go through one row builder with the same word-diff and width-cap decisions, so they occupy the same number of rows (verified by comparing the two row counts inside the builder on the fixtures) and swapping one for the other cannot reflow the transcript under the reader. The `edit` tool also projects its diff synchronously for that first frame instead of waiting on an async file read, and highlighting is dropped for any line whose rendered width differs from its source (Shiki trims trailing whitespace and re-wraps very long lines, which shifts every row and gutter below it). A highlighted body is swapped in only when it occupies exactly as many rows as the body already on screen.
- **Mutation previews use the full width of their row** — the diff width was clamped to a terminal-derived cap (`MAX_TERM_WIDTH`, 210 columns) even when it came from the component itself, so on a wide pane the body was laid out at 210 columns no matter how much room the row had: up to ~90 columns went unused at 300 columns of row, and a split diff's tint stopped well before the right edge. A component-derived width is authoritative and is no longer clamped (the cap still guards the environment-derived fallback), and the legacy `chromeWidth` subtraction (2–3 columns) is gone because the component width is already the inner width — only the fullscreen scrollbar column stays reserved. Measured in the grouped renderer: a rule line now spans 293 of a 300-column row (208 with the cap), and the previously-wasted columns are diff.

### Added

- **Activity API for other extensions** — the object published at `Symbol.for("pi-tool-tree:api")` (and the legacy `pi-tool-tree:activity-api`, which resolves to the same instance) now answers what the session is doing as well as wrapping tools. `getActivity()` returns a live snapshot — phase (`idle`/`waiting`/`thinking`/`responding`/`tool`), the model's current activity label and how long it has been current, the calls running right now with their live elapsed time, and the current run's counters (turns, calls, failures, tool and reasoning time). `getStats()` returns cumulative session totals — completed work time, runs, turns, call counts and failures, tool/reasoning time, and per-tool and per-label breakdowns — seeded from the active branch on resume so a reload keeps the session's history. `subscribe(listener)` delivers labelled transitions (`run-start`, `turn-start`, `label-change`, `thinking-start/end`, `stream-start/end`, `tool-start/end`, `run-end`) with the resulting snapshot, and `formatDuration(ms)` matches the transcript's own formatting. State is fed by pi's events rather than by the renderer, so it is correct in hosts that never paint the grouped rows (RPC, headless, tests); snapshots are copies, throwing listeners are ignored, and subscriptions do not survive a reload. Full reference in [API.md](./API.md), with an overview in the README.
- **Model-named activity groups** — the seven core tools (`read`, `bash`, `grep`, `find`, `ls`, `write`, `edit`) now declare a required `activity` param, so every call carries the phase it belongs to (`exploring`, `implementing`, `testing`, …) and each tree group is headed by that word. The label is stripped before the tool runs and the recorded message keeps exactly the arguments the model sent.
- **Opt-in integration for tool plugins** — other extensions can wrap their own tool definitions through the API published at `Symbol.for("pi-tool-tree:activity-api")` (`wrapTool(tool)`), which adds the schema property, defaults a missing label, and strips it before `execute`. `pi.getAllTools()` exposes no `execute`, so plugin tools cannot be wrapped from the outside; the integration is a no-op when the setting is off.
- **`/cc-tools activity on|off|toggle|status`** — switches the param without restarting pi (core tools re-register live), and the `activityGroups` / `toolActivityParam` settings are now documented.
- **Running group labels shimmer** — while a group has calls in flight, its activity label sweeps a highlight band across the word (Claude Code / ChatGPT "working" effect) as a gradient of the label's own theme color (brightening on dark panels, deepening on light ones), then returns to a constant color when the last call settles. The grouped transcript arms its own repaint while a group is in flight (80ms with the shimmer on, 500ms for a bare live timer) — grouped rows bypass pi's native tool renderer, so nothing else was keeping a running group's rows fresh, which also left the status light frozen mid-run. `activityShimmer` (default `true`) and `/cc-tools shimmer on|off|toggle|status` control it, and the label text itself is never altered — only its per-character color.
- **Pending lights breathe** — running calls now use the circle-breathe cycle (`● → • → · → invisible → · → •`) that agent-family rows always had, instead of the blinking `●`, on a wall-clock frame index so the group header and every row share the same frame without any off-phase misalignment. Agent-family calls keep the same light. `pendingIndicator: "spinner"` (braille `⠃⠉⠘⠰⢠⣀⡄⠆`, repainting at 80ms) and `"dot"` (the classic blinking `●`) remain available through settings and `/cc-tools pending breathe|spinner|dot|status`.
- **Group duration includes thinking time and ticks live** — the header total now sums tool durations *and* the thinking time inside the group, so a phase that reasoned for 19s before a fast tool reads `· 19s` instead of `· <1s`. While the group runs the total keeps counting against the wall clock (repainting with the shimmer, or the 500ms blink when the shimmer is off) and freezes at its final value once the last call settles. A group with no timing data at all still prints no duration, and thinking still does not count as a call.

### Fixed

- **The activity param is actually injected** — the previous sweep read `pi.getAllTools()`, which returns tool metadata without `execute`, so every tool was skipped and the model never saw the param. Core tools are now wrapped at their own registration sites and the dead sweep is gone. (`registerOpenAiToolOverrides` and `registerMcpToolOverrides` are gated on the same missing `execute` field, so they still never fire in the real harness — unchanged by this release).

### Fixed

- **Thinking time no longer runs faster than the clock** — a very fast model (thousands of thinking characters per second) made the thinking duration climb at ~20s per real second, because a block with no timing event fell back to a text-length estimate that assumes 150 chars/s. In-flight thinking now measures the message's own wall clock, a clockless fallback pins its first estimate instead of re-deriving it from the growing stream, and a live group's total is capped by its wall-clock span so several thinking rows sharing one in-flight block cannot be summed into a total that runs at a multiple of real time.
- **The activity-label sweep is always visible** — the band now guarantees a minimum separation from the label's own color (a muted thinking level could sit close to the theme's text, leaving the sweep looking like a static word), sweeps a wider band, and completes a pass in 1.8s instead of 1.2s.

### Changed

- **Cleaner responsive mutation diffs** — edit/write previews now use lighter shared hatch/rule/rail chrome, omit old/new and per-edit headings, share one rule between edit blocks, reserve the fullscreen scrollbar cell, and switch to unified mode before split columns wrap excessively. Width changes now always trigger a complete diff rebuild instead of leaving the one-frame reflow fallback behind; full-width panes tolerate modest wrapping and return to split mode. Compact gutters drop redundant +/- markers, and nested preview rails align directly beneath their tool status marks.
- **Flush-left assistant prose** — assistant text keeps pi's own Markdown rendering again: no ` ● ` dot and no extra three-space indent. Only prose containing display math (`\[…\]`, `$$…$$`) or task-status transcripts still uses the custom paragraph renderer (now flush left, matching pi's one-space assistant padding).
- **Blank lines between transcript blocks** — a blank line follows agent prose and separates consecutive activity groups, so phases read as distinct blocks instead of one wall of rows.
- **Only tool calls are counted** — a thinking row no longer inflates the group header (one thought plus four calls used to read `5 calls`), and a run with no tool call at all (a trailing thought, say) no longer prints a `N calls` header at all.
- **Unlabeled groups show `working`** — a group whose calls carry no label (the first group of a run, a tool that never declared `activity`, an MCP call) now falls back to the default label instead of printing a bare `3 calls` header. Calls that can inherit a previous group's label still do.
- **Group counts use the secondary gray** — `N calls · 5s` now renders in the same theme-derived gray as the `Thought for Xs` rows (`Worked line`/branch chrome) instead of the dimmer body gray, so the counts read as metadata next to the label rather than nearly disappearing on light themes.

### Fixed

- **`activity` is no longer a `required` schema property** — declaring it required broke every consumer that re-validates arguments against the advertised schema: pi-ptc-next mirrors pi's tool parameters for its Python callables, so `read(path=…)` / `bash(command=…)` calls from `code_execution` failed with *must have required properties activity*. The property is still declared (with `default: "working"` and an "Always include…" description), `prepareArguments` still defaults a missing label, and grouping is unaffected — it just no longer lies about being mandatory.
- **Hidden thinking stays hidden** — `hideThinkingBlock` (Ctrl+T / settings.json) now wins over `thinkingMode`. When thinking is hidden, the newest thought no longer streams a live body into the tree; only its one-line `Thinking… Xs` / `Thought for Xs` summary stays until you explicitly expand it.
- **User message bubbles keep their padding** — block spacing normalised every content block by trimming its leading/trailing blank lines, but pi pads a user message with background-filled rows *inside* its `Box`, so the bubble collapsed to a single line with its padding gone. Only assistant rows are trimmed now; user messages, subagent frames and other custom blocks keep the padding they render.
- **Running groups now actually repaint** — the live-frame loop armed from the group header cleared caches but never asked pi to draw again: pi's component `invalidate()` only clears caches, and the repaint request lives in the render context (which is how the ● blink wakes the TUI). The effect was a shimmer frozen at a single frame, a spinner stuck on one glyph and a duration that never advanced. Each frame now requests a render, so the sweep, the pending light and the ticking total all animate; the test renders a running group with a recording `ui` and fails if a frame does not request a repaint.
### Fixed

- **`Turn took` is now `Agent took`, and the bracket counts real turns** — the end-of-run status line reads `✻ Agent took 2m 30s (Total time 8m 4s · 3 turns)`. "Turn" previously named two different things: the agent run since your last prompt, and pi's own turn (one model response plus its tool calls). The label now names the run, and the count is how many turns actually fired inside it. Transcripts whose runs were never stamped fall back to the number of assistant messages in that run. Legacy `Turn took` lines baked into older transcripts are still scrubbed on load.
- **Total turn time excludes user idle time** — `Total time` now sums completed `Agent took` durations instead of measuring wall-clock time since the session's first prompt. Resumed and reloaded sessions rebuild the cumulative total from persisted run-duration metadata.
- **Grouped Bash commands show live progress** (Raine Virta) - collapsed running Bash rows display their latest non-empty output line beneath the command.
- **Final timing status stays presentation-only** (Raine Virta) - the `Agent took` line renders as a styled TUI component without adding ANSI escapes or display text to persisted assistant messages.

## 1.0.75 — 2026-07-29

### Fixed

- **Herdr progress with spinner verbs** — themed working messages (`Cooking…`, `Syncing…`, …) no longer break [herdr](https://herdr.dev) agent progress. Stock herdr pi screen detection only matches literal `Working...`; when `HERDR_ENV=1` the spinner now reports `working` / `idle` over herdr’s socket (same `herdr:pi` lifecycle authority as the official pi integration). Spinner UI and verbs are unchanged. Outside herdr the extension is a no-op for this path.

## 1.0.74 — 2026-07-18

### Fixed

- **Grouped tool boxes keep Agent breathe aligned** — group rows strip all breathe glyphs (including `·` and the blank off-phase) before re-prefixing a fresh light, so titles no longer walk sideways. Group header/child lights also follow the shared blink phase (and Agent breathe) instead of wall-clock `isBlinkOn()`.

## 1.0.73 — 2026-07-18

### Fixed

- **Agent rows align with other tools again** — removed the extra leading indent that only applied to Agent-family tool rows.
- **Agent breathe stays centered** — drop double-width `⬤` (it walked the baseline). Cycle is now single-cell glyphs `● → • → · → (invisible) → · → •` so the optical center never moves.

## 1.0.72 — 2026-07-18

### Changed

- **Agent tools breathe** — `Agent` / subagent tools use a size cycle while pending instead of the ordinary on/off `●` blink, so agent work reads as a different kind of tool.

## 1.0.71 — 2026-07-18

### Fixed

- **Long-running tools no longer freeze their status dots** — the 15s stale watchdog was treating quiet tools (no `tool_execution_update`) as leaked and killing the blink timer mid-run. While an agent is live the timer now heartbeats itself; stale cleanup only runs after the agent finishes. Also stop clearing blink state on `turn_end` (turns end before tools run).

## 1.0.70 — 2026-07-17

### Fixed

- **Live tool status dots blink again while commands stream** — partial tool rows re-arm the blink timer from both the call header and the live preview path, and `tool_execution_update` keeps the 15s stale watchdog from killing blink mid-bash.
- **Interrupted / resumed tools no longer blink forever** — only tools with `executionStarted` during a live agent run count as pending. History partials (resume, compaction, `/tree`, aborted runs without a toolResult) settle to a static green/dim dot and clear blink timers on `session_start`.

### Changed

- **No more `Running...` status row** — the blinking `●` on the tool heading is the only in-flight indicator. Live non-empty line count moves to the heading as muted `(N lines)`; the body shows only the output tail while streaming.

## 1.0.69 — 2026-07-17

### Changed

- **Package rename** — npm package is now `pi-claude-code-ui` (was `pi-claude-style-tools`). Install with `pi install npm:pi-claude-code-ui` (or your usual npm/pi install path).
- **Claude-style status dots** — pending markers no longer fall back to a hollow outlined `○`. They now blink as a bold filled `●` that is either solid or fully gone (space-kept alignment), matching Claude Code.
- **Heavier (not huge) dots** — success/error/pending use bold `●` (not oversized `⬤`) so they read a bit larger without dominating the tool title.
- **Bare branch connectors** — tree leads use `├` / `└` with no horizontal `─` arm, including Magic Context todo overlay rows (armed `├─` / `└─` input is normalized to bare).

## 1.0.68 — 2026-07-15

### Changed

- **Snappier spinner glyphs** — loader frame interval `250ms → 170ms` so `· ✢ ✳ ✶ ✻ ✽` cycles feel more lively while working.
- **Bigger verb pool** — many more whimsical working verbs (debugging, refactoring, brainstorming, overthinking, …) so the status line repeats less often.

### Fixed

- **Stale tool-group headers / weird counts** — settled `ToolGroupComponent` rows no longer keep serving a cached header after a child tool finishes or updates. Child mutations now mark only the parent group dirty (no sibling cascade), so counts like `N running` clear immediately instead of lingering until the next tool/message.
- **Long-chat tool-group re-render cost** — fully-settled groups memoize their rendered lines and skip child walks on warm frames (scroll, spinner, expand elsewhere). This was the main remaining long-history regression vs stock pi when `groupToolCalls` is on.
- **Preview styling O(output)** — `buildPreviewText` now styles only the lines that will be shown; bash finished/collapsed paths collect a tail (or count-only) instead of materializing every non-empty line; live previews reuse the single-pass collector.
- **Todo overlay hot path** — non-todo containers bail after the first non-empty line instead of scanning every rendered line on every frame.
- **Shiki cache across turns** — `hlCache` is no longer wiped on every `turn_end` (still cleared on session shutdown / theme rebind). Repeated expand/scroll of the same diffs no longer re-highlights from scratch each turn.
- **Session map cleanup** — `WRITE_EXISTED_BEFORE` is cleared on `session_shutdown` so long-lived agent processes don’t retain per-write entries forever.

### Performance notes

Bench (`bun scripts/benchmark-tools.ts`, width 120):

| Case | baseline warm | full (this package) warm |
|------|---------------|---------------------------|
| assistant-history-120 | ~0.44 ms | **~0.09 ms** (faster than stock) |
| tool-history-120 (grouped) | ~0.43 ms | **~0.27 ms** (faster than stock) |
| tool-history-240 (grouped) | ~0.90 ms | ~1.2 ms (first-render still heavier due to outlines/diffs; warm path much closer) |

Cold/first render of rich tool chrome is still intentionally heavier than stock pi (borders, branch connectors, diff previews). Warm long-chat frames — the lag users feel while scrolling — are now at or below stock for assistant history and grouped tool history.

## 1.0.67 — 2026-07-15

### Fixed

- **Magic Context tool rendering** — `ctx_search`, `ctx_memory`, `ctx_note`, `ctx_expand`, `ctx_reduce`, and `todowrite` now use the same Claude-style tool rows as other external tools.
- **Todo overlay labels** — task IDs no longer display a leading `#`.
- **Hermes memory notice styling** — the auto-review notice now matches thinking text color and weight instead of applying additional ANSI dimming.

## 1.0.66 — 2026-07-15

### Fixed

- **Thinking presentation** — thinking text is no longer italic, visible thinking uses the `∴` marker, and collapsed “Thinking…” / “Thought for…” rows omit the marker while retaining the correct text indentation.
- **Hermes memory notice styling** — the `💾 Memory auto-reviewed and updated` notification is restyled locally as a translucent `✻ Memory auto-reviewed and updated`, without modifying the pi-hermes-memory extension.
- **Todo overlay alignment** — todo headings and task rows now have the missing indent, and their `├─` / `└─` connectors follow the configured tool branch color.

## 1.0.65 — 2026-07-01

### Fixed

- **Idle crash / "job failed" while pi sits stale** — leaked blink entries (a tool that completed without clearing, or a turn that ended without `turn_end`) kept the 500 ms blink timer re-arming forever, forcing full TUI re-renders twice a second while idle. Each re-render re-ran the layout and either tripped pi's render width-assertion (crash) or grew RSS until the OS killed pi (silent crash → Ghostty "job failed"). Added an `agent_end` clear and a 15 s staleness watchdog so leaked entries can't sustain the re-render loop.
- **Render width-assertion crash on wide content** — `clampLineWidth`/`padRenderedLineToWidth` now cap at `process.stdout.columns`, so the extension never emits a line wider than the real terminal even when pi hands it a too-wide width (e.g. content later placed in a narrower side panel).

## 1.0.64 — 2026-07-01

### Added

- **`read` on `SKILL.md` shows as `[skill]`** — paths ending in `SKILL.md` use the same `[skill]` label styling as custom skill messages (krikchaip).

### Fixed

- **Finished tool rows no longer pulse as pending after reload** — only `isPartial` marks a row pending; missing `executionStarted` on history rows no longer triggers blink timers (krikchaip).
- **Tool row backgrounds after `/reload`** — strip the outer `Box` success background ANSI on rebuilt rows so transparent/outline mode stays clean (krikchaip).
- **Unmatched partial tool calls in old branches** — partial rows without `executionStarted` show a static muted dot instead of an endless pending blink (krikchaip).
- **Partial rows at tree-navigated leaves** — when the result lives off the selected branch, blink only while an agent is actually running; settled history renders as finished (green when succeeded) (krikchaip).
- **Duplicate bash expand hint** — finished bash rows keep “expand” on the summary line only; the preserved output preview no longer repeats it (krikchaip).

## 1.0.63 — 2026-07-01

### Fixed

- **Random crash on large diffs** — rendering a large edit or `apply_patch` could throw `RangeError: Maximum call stack size exceeded`. Root cause: the split/unified diff renderers computed the max line number via `Math.max(...diff.lines.map(...))`, spreading the *entire* diff line array as function arguments — fine for small diffs, but a stack overflow on diffs with thousands of lines. Replaced with a loop-based `maxLineNumber()` that returns identical results. No visual or behavioral change.
- **Shiki import no longer leaves a dangling rejected promise** — a failed `import("@shikijs/cli")` (missing dep, transient error) previously left a permanently-rejected promise that could surface as an unhandled-rejection crash under strict modes. The loader now resets on failure so the next render retries.

### Changed

- **Lower CPU / heat during long-running bash** — the bash tool's live preview re-split and re-filtered the *entire* output on every partial update (bash throttles updates every ~100ms and the pending-dot blink re-invalidates every 500ms), scaling linearly with output size. It now collects only the visible tail lines and a total count in a single pass, so cost no longer grows with output length.
- **Bounded Shiki concurrency for multi-edit / multi-file diffs** — edit and `apply_patch` call-phase previews previously fired all syntax-highlighting jobs at once via `Promise.all`, causing CPU spikes on large multi-block diffs. They now run with a small concurrency cap (2), preserving ordered output.
- **Spinner no longer keeps running after the UI stops** — the 250ms Loader animation loop (and its `requestRender` calls) kept firing after the TUI was stopped. It now short-circuits and stops itself when the UI is stopped, so it can't keep the event loop or CPU alive as an orphan.
- **More timers `unref`'d** — the deferred chrome-rebind `setTimeout` (fired on `/resume` / `/new` / `/fork`) and the same-frame working-message `setTimeout` were not unref'd, keeping the Node event loop alive. Both now `unref` so they can't hold the process open or spin idle.

No functionality changed in this release — output is byte-identical for all existing cases; the diffs above are strictly CPU/stability improvements verified by `npm run typecheck` and `bun scripts/benchmark-tools.ts`.

## 1.0.62 — 2026-06-22

### Fixed

- **"Turn took" line no longer appears mid-stream** — the end-of-run status line was showing while the assistant was still streaming text. Root cause: the component render path gated on `message.stopReason === "stop"`, but the Anthropic provider initializes the live message's `stopReason` to `"stop"` at creation and only updates it to the real value when `message_delta` arrives near the end of the stream — so the gate was already true during streaming. The component path now gates on the `explicitDuration` flag stamped by the `message_end` handler (which fires after `message_delta`, once the real `stopReason` is known), so the line appears only after the stream truly closes. The `message_end` path was already correct (it fires post-`message_delta`); only the live component fallback was premature.

## 1.0.61 — 2026-06-22

### Changed

- **Renamed "Worked for" → "Turn took"** — the end-of-run status line now reads `✻ Turn took 2m 30s (Total time 1h 12m 30s · 14 turns)`. The session-total duration now always shows seconds and only adds minutes/hours once the session has actually lasted that long (e.g. `45s`, `12m 30s`, `1h 12m 30s`); the bracket label is now capitalized as "Total time".

## 1.0.60 — 2026-06-22

### Changed

- **"Worked for …" only on the true end of a run** — the line now appears only when the model finishes all of its turns for a prompt (`stopReason === "stop"`), instead of after every assistant message that didn't end in a tool call. Intermediate stops that pi retries through (`error`, `aborted`, `length`/max-tokens, compaction retries) no longer get a premature "Worked for" line — it shows once, when the model is actually done.
- **Session total + turn count on the Worked line** — the line now reads `✻ Worked for 2m 30s (total time 1h 12m · 14 turns)`, where the bracket is the running session-wide elapsed time and the number of prompts you've sent. Totals are seeded from the full message history, so `/resume` picks up past prompts and the original session start. `/new` resets the counters.

## 1.0.59 — 2026-06-19

### Fixed

- **Scrolling / expand lag on long chats** — every re-render (scroll, tool expand, theme tick) re-ran the per-line ANSI stripping behind copy-zone markers (`applyTerminalCopyZones`), per-line glyph normalization, and user-message border boxing for *every* message in the history. That work scaled linearly with chat length and dominated CPU on long sessions (the more messages, the slower each frame). The rendered output of assistant, user, and custom-message components is now memoized per `(width, branch-visual-epoch)` on the component instance and reused on warm re-renders, with the cache dropped whenever content actually changes (`updateContent` / `rebuild`) or the theme chrome epoch bumps. Warm re-render of a 120-message history drops from ~5.9 ms to ~0.16 ms and stays flat as the chat grows instead of scaling with it. Output is byte-identical (same rendered line counts and content); no functionality changed.

## 1.0.58 — 2026-06-17

### Fixed

- **Transparent tool rows after `/resume`** — Pi’s `ToolExecutionComponent` uses the global theme singleton for `toolPendingBg` / `toolSuccessBg` / `toolErrorBg`. Re-apply transparent overrides on that object and before every `updateDisplay()`, with extra deferred chrome rebind after history rebuild on resume/new/fork.
- **Stale tool row chrome on theme switch** — bump branch/render epoch when the active theme name or color fingerprint changes so cached tool lines pick up new palette.

## 1.0.57 — 2026-06-17

### Changed

- **Branch connectors default** — `├─` `└─` `│` use **fixed rgb(72)** unless you set `/cc-tools branch theme` or a custom gray. `/cc-tools branch reset` restores that default.

### Fixed

- **Resume / session switch theme mix** — on `session_start` (especially `resume`, `new`, `fork`), rebind tool chrome from the active pi theme (palette cache bust, Shiki light/dark, branch epoch, full UI invalidate) plus deferred passes so other extensions can `setTheme` in the same tick without cross-package coupling.
- **Hidden thinking summary** sticks on "Thinking…" when `thinking_end` lands on the same frame as Pi's `updateContent` — per-message active/duration flags plus a deferred UI refresh so "Thought for Ns" appears right away.
- **Spinner footer** applies the same deferred sync on thinking start/end so "thought for Ns" shows immediately when thinking finishes.

### Changed

- **Unified container chrome** — user message box, tool outline rules, rounded code fences, and branch connectors share one theme-derived color (`dim` → `muted` → `borderMuted`) so light themes do not get harsh dark user borders or overly bright branches.
- **User message fill** — strip nested `Box` → `Markdown` backgrounds so the framed user row stays transparent and matches terminal chrome (fixes dark slabs inside the border).
- **Light-theme branch chrome** — when the active theme has a light panel, outline/branch colors are attenuated toward mid-gray so `├─` `└─` `│` and user borders are not washed-out bright; `/cc-tools status` no longer implies theme mode uses fixed gray 72.

## 1.0.56 — 2026-06-17

### Fixed

- **Theme-adaptive tool chrome** re-derives when the active pi theme’s resolved colors change (fingerprint of `success`, `borderMuted`, `accent`, etc.), not only when the theme object identity changes. Fixes stale borders/dots/diffs after external theme sync (e.g. Ghostty) without coupling to other extensions.

### Changed

- Palette cache tracks `theme.name` plus color fingerprint; removed cross-extension global bust symbols.

## 1.0.55 — 2026-06-17

- Internal: theme name in cache key (superseded by 1.0.56 fingerprint).

## 1.0.54 — 2026-06-17

### Changed

- **Branch connectors** (`├─` `└─` `│`): default **`theme`** mode (was fixed gray). Uses **dim → muted → thinkingText**, same family as thought/gray prose.
- **Pending tool dots** (○): use theme **dim** when theme-adaptive; grouped counts use the same pending color.

### Fixed

- `/cc-tools branch reset` restores theme-following default, not fixed rgb(72).

## 1.0.53 — 2026-06-17

### Fixed

- **Light theme edit/write diffs**: auto-select Shiki `github-light` vs `github-dark`; light panel tint base; Shiki contrast normalization for light backgrounds.
- **Light theme tool status chrome**: pending ○ / blink uses softer `borderMuted` instead of heavy `muted`; grouped tool pending counts match.

## 1.0.52

- Theme-adaptive diff and branch tooling updates.