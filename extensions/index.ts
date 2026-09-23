import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";

import type {
	BashToolDetails,
	EditToolDetails,
	ExtensionAPI,
	GrepToolDetails,
	ReadToolDetails,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	keyHint,
	keyText,
	rawKeyHint,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	Container,
	deleteAllKittyImages,
	getCapabilities,
	getImageDimensions,
	imageFallback,
	Markdown,
	ProcessTerminal,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

import * as Diff from "diff";
import type { BundledLanguage, BundledTheme } from "shiki";

import {
	buildBashCommandPresentation,
	buildBashPreview,
	describeBashSource,
	formatBashDuration,
	getLastBashOutputLine,
} from "./bash-command";
import { resolveDiffPresentationMode, type DiffViewMode } from "./diff-mode";

const RESET = "\x1b[0m";
const TRANSPARENT_BG = "\x1b[49m";
const TRANSPARENT_RESET = `${RESET}${TRANSPARENT_BG}`;

// Code box borders and thinking/thought text: branch color + OUTLINE_CHROME_BRIGHTEN.
// Branch ├╰│ stay at `currentToolBranchAnsi` (see syncOutlineChromeFromBranch).
let BORDER_COLOR = "\x1b[38;5;238m";
let CODE_BLOCK_LANG_FG = "\x1b[38;2;95;95;95m";
const CHROME_ITALIC = "\x1b[3m";
/** Lift outline chrome above branch connectors so boxes and thought read brighter. */
const OUTLINE_CHROME_BRIGHTEN = 64;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const ANSI_PRESENT_RE = /\x1b\[[0-9;]*m/;
const PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-container-render");
const TOOL_RENDER_CACHE = Symbol.for("pi-claude-style-tools:tool-render-cache");
const ACTIVITY_RENDER_CACHE = Symbol.for("pi-claude-style-tools:activity-render-cache");
const COMPONENT_PARENT = Symbol.for("pi-claude-style-tools:component-parent");
const PARENT_TRACKING_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-parent-tracking");
const TOOL_CACHE_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-tool-cache-invalidation");
const TOOL_IMAGE_EXPAND_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-read-image-expansion");
const CUSTOM_MESSAGE_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-custom-message-render");
const UI_NOTIFY_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-ui-notifications-v2");
const WRAP_MARK = "\uE000";
const CLIP_MARK = "\uE001";
const TRAILING_MARK = "  · ";
const KITTY_IMAGE_PREFIX = "\x1b_G";
const ITERM2_IMAGE_PREFIX = "\x1b]1337;File=";

let toolBackgroundMode: "default" | "transparent" | "outlines" = "outlines";

interface SettingsFile {
	toolBackground?: "default" | "transparent" | "outlines" | "border";
	readOutputMode?: "hidden" | "summary" | "preview";
	searchOutputMode?: "hidden" | "count" | "preview";
	mcpOutputMode?: "hidden" | "summary" | "preview";
	previewLines?: number;
	expandedPreviewMaxLines?: number;
	extraExpandedPreviewMaxLines?: number;
	extraToolOutputExpanded?: boolean;
	groupToolCalls?: boolean;
	/** Group neighboring tool calls by the model's per-call `activity` label. Default true. */
	activityGroups?: boolean;
	/** Pending light for individual tool calls: `breathe` (default, circle-breathe ● • ·), `spinner` (braille), or `dot`. Group headers stay steady. */
	pendingIndicator?: "breathe" | "spinner" | "dot";
	/** Sweep a highlight across the activity label while its group is running. Default true. */
	activityShimmer?: boolean;
	/** Inject the required `activity` param into every tool schema. Default true. */
	toolActivityParam?: boolean;
	bashOutputMode?: "opencode" | "summary" | "preview";
	bashCollapsedLines?: number;
	/** Verbatim script lines shown while bash is running or after failure. Defaults to 8. */
	bashCommandPreviewLines?: number;
	/** Show a small live output preview while tools are still running. Defaults to true. */
	liveToolPreview?: boolean;
	/** Number of live output lines to show while collapsed. Defaults to 5. */
	liveToolPreviewLines?: number;
	showTruncationHints?: boolean;
	diffCollapsedLines?: number;
	/** Diff layout: auto selects split at diffSplitMinWidth, otherwise unified. */
	diffViewMode?: DiffViewMode;
	/** Minimum available columns for auto mode to use a split diff. Defaults to 132. */
	diffSplitMinWidth?: number;
	diffTheme?: string;
	diffColors?: Record<string, string>;
	/**
	 * When true (default), derive borders, dim text, branch rules, and diff
	 * accents from the active pi theme via `theme.getFgAnsi`/`getBgAnsi`.
	 * Explicit `diffTheme` / `diffColors` always win over theme-derived
	 * defaults so users keep full control.
	 */
	themeAdaptive?: boolean;
	/**
	 * Thinking display mode. `live` (default): only the currently-streaming
	 * thinking is expanded; finished thinking collapses to a one-line
	 * `Thought for Xs` row (Ctrl+O still expands it). `full`: thinking always
	 * renders expanded, like stock pi.
	 */
	thinkingMode?: "live" | "full";
	/** Gray level 0–255 for ├ ╰ │ when branch color mode is `fixed`. */
	toolBranchRgbGray?: number;
	/** `fixed` (default): rgb gray 72, theme-independent. `theme`: dim → muted → borderMuted. */
	toolBranchColorMode?: "theme" | "fixed";
}

let _settingsCache: { value: SettingsFile; timestamp: number } | null = null;
const SETTINGS_CACHE_TTL_MS = 5_000;

function readSettings(): SettingsFile {
	const now = Date.now();
	if (_settingsCache && now - _settingsCache.timestamp < SETTINGS_CACHE_TTL_MS) {
		return _settingsCache.value;
	}
	const cwdPath = `${process.cwd()}/.pi/settings.json`;
	const homePath = `${process.env.HOME ?? ""}/.pi/settings.json`;
	const merged: SettingsFile = {};
	for (const path of [cwdPath, homePath]) {
		try {
			if (!path || !existsSync(path)) continue;
			const raw = JSON.parse(readFileSync(path, "utf8"));
			if (raw && typeof raw === "object") Object.assign(merged, raw as SettingsFile);
		} catch {
			// ignore invalid settings files
		}
	}
	_settingsCache = { value: merged, timestamp: now };
	return merged;
}

function writeSettingsKey(key: string, value: unknown): void {
	_settingsCache = null; // invalidate cache on write
	const home = process.env.HOME ?? "";
	if (!home) return;
	const dir = `${home}/.pi`;
	const path = `${dir}/settings.json`;
	let settings: Record<string, unknown> = {};
	try {
		if (existsSync(path)) settings = JSON.parse(readFileSync(path, "utf8")) ?? {};
	} catch { /* start fresh */ }
	if (value === undefined) {
		delete settings[key];
	} else {
		settings[key] = value;
	}
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
	} catch { /* best effort */ }
}

let toolBackgroundOverride: "default" | "transparent" | "outlines" | null = null;

function syncToolBackgroundMode(): void {
	if (toolBackgroundOverride) {
		toolBackgroundMode = toolBackgroundOverride;
		return;
	}
	const settings = readSettings();
	// Backward compat: "border" was renamed to "outlines"
	const raw = settings.toolBackground === "border" ? "outlines" : settings.toolBackground;
	toolBackgroundMode = raw ?? "outlines";
}

function setThemeBg(theme: unknown, key: string, value: string): void {
	const themeAny = theme as any;
	if (themeAny.bgColors instanceof Map) {
		themeAny.bgColors.set(key, value);
	} else if (themeAny.bgColors && typeof themeAny.bgColors === "object") {
		themeAny.bgColors[key] = value;
	}
}

const PI_GLOBAL_THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

function getGlobalPiTheme(): unknown {
	return (globalThis as any)[PI_GLOBAL_THEME_KEY];
}

/** Pi's ToolExecutionComponent reads `theme` from globalThis — keep it in sync with ctx.ui.theme. */
function applyToolBackgroundMode(theme: unknown): void {
	syncToolBackgroundMode();
	const targets = new Set<unknown>();
	if (theme) targets.add(theme);
	const globalTheme = getGlobalPiTheme();
	if (globalTheme) targets.add(globalTheme);
	for (const t of targets) {
		if (toolBackgroundMode === "default") continue;
		setThemeBg(t, "toolPendingBg", TRANSPARENT_BG);
		setThemeBg(t, "toolSuccessBg", TRANSPARENT_BG);
		setThemeBg(t, "toolErrorBg", TRANSPARENT_BG);
	}
}

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

function stripRenderedHeadingMarkers(line: string): string {
	return line.replace(/^((?:\x1b\[[0-9;]*m|[ \t])*)#{3,6}[ \t]*((?:\x1b\[[0-9;]*m)*)/, "$1$2");
}

const PLAIN_FENCE_LANGS = new Set(["text", "txt", "plain", "plaintext", ""]);

function parseRenderedFenceLine(line: string): { kind: "open" | "close"; language: string } | undefined {
	const plain = stripAnsi(line).trim();
	if (plain === "```") return { kind: "close", language: "" };
	if (!plain.startsWith("```")) return undefined;
	const rest = plain.slice(3).trim();
	if (rest.includes("`")) return undefined;
	return { kind: "open", language: rest };
}

function formatCodeBlockLanguageLabel(language: string): string {
	const raw = language.trim();
	if (!raw) return "";
	return raw.toLowerCase();
}

function mutedDotFill(count: number): string {
	if (count <= 0) return "";
	return `${BORDER_COLOR}${"·".repeat(count)}${TRANSPARENT_RESET}`;
}

function padRenderedLineToWidth(line: string, width: number): string {
	if (width <= 0) return "";
	const ceiling = Math.min(width, terminalColumnCeiling() || width);
	const gap = ceiling - visibleWidth(line);
	if (gap <= 0) return line;
	return line + " ".repeat(gap);
}

function isCodeBoxChromeLine(line: string): boolean {
	const plain = stripAnsi(line).trim();
	if (!plain) return false;
	if (/^[╭╮╰╯│·\s]+$/.test(plain) && /[╭╮╰╯│]/.test(plain)) return true;
	if (/^╭/.test(plain) && /╮$/.test(plain)) return true;
	if (/^╰/.test(plain) && /╯$/.test(plain)) return true;
	return false;
}

function isBorderedContentLine(line: string): boolean {
	const plain = stripAnsi(line).trim();
	return plain.startsWith("│") && plain.endsWith("│") && plain.length > 2;
}

function extractBorderedInnerForCopy(line: string): string {
	const plain = stripAnsi(line);
	const start = plain.indexOf("│");
	const end = plain.lastIndexOf("│");
	if (start === -1 || end <= start) return stripAnsi(line).trim();
	return plain.slice(start + 1, end).replace(/^\s+/, "").replace(/\s+$/, "");
}

function applyTerminalCopyZones(lines: string[]): string[] {
	if (!Array.isArray(lines) || lines.length === 0) return lines;
	const out: string[] = [];
	let inZone = false;
	for (const line of lines) {
		if (isCopyExcludedChromeLine(line)) {
			if (inZone) {
				out[out.length - 1] += OSC133_ZONE_END;
				inZone = false;
			}
			out.push(line);
			continue;
		}
		const payload = copyPayloadForLine(line);
		if (!payload) {
			out.push(line);
			continue;
		}
		if (!inZone) {
			out.push(`${OSC133_ZONE_START}${line}`);
			inZone = true;
		} else {
			out.push(line);
		}
	}
	if (inZone && out.length > 0) {
		out[out.length - 1] += OSC133_ZONE_END + OSC133_ZONE_FINAL;
	}
	return out;
}

function isCopyExcludedChromeLine(line: string): boolean {
	return isCodeBoxChromeLine(line);
}

function copyPayloadForLine(line: string): string | undefined {
	if (isCopyExcludedChromeLine(line)) return undefined;
	if (isBorderedContentLine(line)) return extractBorderedInnerForCopy(line);
	const plain = stripAnsi(line).trim();
	if (!plain) return undefined;
	return plain;
}

function roundedCodeBlockTop(width: number, language: string): string {
	if (width <= 1) return `${BORDER_COLOR}│${TRANSPARENT_RESET}`;
	const label = formatCodeBlockLanguageLabel(language);
	if (!label || width < 8) {
		const inner = Math.max(0, width - 2);
		return `${BORDER_COLOR}╭${TRANSPARENT_RESET}${mutedDotFill(inner)}${BORDER_COLOR}╮${TRANSPARENT_RESET}`;
	}
	const labelStyled = `${CODE_BLOCK_LANG_FG}${CHROME_ITALIC}${label}${RESET}${TRANSPARENT_RESET}`;
	const labelW = visibleWidth(labelStyled);
	const dotCount = Math.max(0, width - 6 - labelW);
	return `${BORDER_COLOR}╭· ${TRANSPARENT_RESET}${labelStyled} ${mutedDotFill(dotCount)}${BORDER_COLOR} ╮${TRANSPARENT_RESET}`;
}

function roundedCodeBlockBottom(width: number): string {
	if (width <= 1) return `${BORDER_COLOR}│${TRANSPARENT_RESET}`;
	const inner = Math.max(0, width - 2);
	return `${BORDER_COLOR}╰${TRANSPARENT_RESET}${mutedDotFill(inner)}${BORDER_COLOR}╯${TRANSPARENT_RESET}`;
}

function borderedCodeBlockLine(line: string, width: number): string {
	const innerWidth = Math.max(1, width - 4);
	let content = line;
	if (visibleWidth(content) > innerWidth) {
		content = truncateToWidth(content, innerWidth, "", false);
	}
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
	return `${BORDER_COLOR}│${TRANSPARENT_RESET} ${content}${padding} ${BORDER_COLOR}│${TRANSPARENT_RESET}`;
}

function boxRenderedCodeBlock(bodyLines: string[], language: string, width: number): string[] {
	const safeWidth = Math.max(4, Number.isFinite(width) ? Math.floor(width) : 0);
	const framed = [
		roundedCodeBlockTop(safeWidth, language),
		...bodyLines.map((line) => borderedCodeBlockLine(line, safeWidth)),
		roundedCodeBlockBottom(safeWidth),
	];
	return framed.map((line) => padRenderedLineToWidth(line, safeWidth));
}

function sanitizeRenderedTextBlockLines(lines: string[], width?: number): string[] {
	const result: string[] = [];
	let i = 0;
	const canBox = typeof width === "number" && width > 0;
	while (i < lines.length) {
		const fence = parseRenderedFenceLine(lines[i]);
		if (fence?.kind === "open") {
			const language = fence.language;
			const hideBox = PLAIN_FENCE_LANGS.has(language.trim().toLowerCase());
			const body: string[] = [];
			i++;
			while (i < lines.length) {
				const close = parseRenderedFenceLine(lines[i]);
				if (close?.kind === "close") {
					i++;
					break;
				}
				body.push(lines[i]);
				i++;
			}
			if (hideBox) {
				result.push(...body);
			} else if (canBox && (body.length > 0 || language.trim())) {
				result.push(...boxRenderedCodeBlock(body, language, width));
			} else {
				result.push(...body);
			}
			continue;
		}
		if (fence?.kind === "close") {
			i++;
			continue;
		}
		result.push(stripRenderedHeadingMarkers(lines[i]).replace(/###/g, ""));
		i++;
	}
	return result;
}

function isBlankLine(text: string): boolean {
	return stripAnsi(text).trim().length === 0;
}

/** Copy-zone markers (OSC 133) carry no visible text, so they never count as content. */
const OSC133_MARKER_RE = /\x1b\]133;[ABC](?:\x07|\x1b\\)?/g;

function isBlankTranscriptLine(line: string): boolean {
	return stripAnsi(line.replace(OSC133_MARKER_RE, "")).trim().length === 0;
}

function osc133MarkersIn(line: string): string {
	return line.match(OSC133_MARKER_RE)?.join("") ?? "";
}

/**
 * Pi pads every message with its own blank lines; the transcript owns block spacing
 * instead, so drop content edges but keep any copy-zone markers they were carrying.
 */
function trimBlankEdges(lines: string[]): string[] {
	let start = 0;
	let lead = "";
	while (start < lines.length && isBlankTranscriptLine(lines[start])) {
		lead += osc133MarkersIn(lines[start]);
		start++;
	}
	let end = lines.length - 1;
	let tail = "";
	while (end >= start && isBlankTranscriptLine(lines[end])) {
		tail = osc133MarkersIn(lines[end]) + tail;
		end--;
	}
	const kept = lines.slice(start, end + 1);
	if (kept.length === 0) return kept;
	if (lead) kept[0] = lead + kept[0];
	if (tail) kept[kept.length - 1] = kept[kept.length - 1] + tail;
	return kept;
}

function terminalColumnCeiling(): number {
	const cols = typeof process !== "undefined" ? process.stdout?.columns : undefined;
	return Number.isFinite(cols) && (cols as number) > 0 ? (cols as number) : 0;
}

/**
 * Memo for clampLineWidth. A grouped transcript re-emits every line on every repaint, and
 * measuring grapheme clusters costs ~30µs per line — so the same thousands of lines were
 * measured again and again (the whole cost of typing in a long session). The composed strings
 * are byte-identical between frames, so the answer is cached per (ceiling, line).
 */
const CLAMP_CACHE = new Map<number, Map<string, string>>();
const CLAMP_CACHE_MAX_ENTRIES = 20000;

function clampLineWidth(line: string, width: number): string {
	if (width <= 0) return "";
	// Hard ceiling: never emit a line wider than the real terminal. pi sometimes
	// hands renderers a width wider than stdout.columns (e.g. content later placed
	// in a narrower side panel), which trips pi's render width-assertion crash.
	const ceiling = Math.min(width, terminalColumnCeiling() || width);
	if (ceiling <= 0) return "";
	let bucket = CLAMP_CACHE.get(ceiling);
	if (bucket) {
		const hit = bucket.get(line);
		if (hit !== undefined) return hit;
	} else {
		bucket = new Map();
		CLAMP_CACHE.set(ceiling, bucket);
	}
	const clamped = visibleWidth(line) > ceiling ? truncateToWidth(line, ceiling) : line;
	if (bucket.size >= CLAMP_CACHE_MAX_ENTRIES) bucket.clear();
	bucket.set(line, clamped);
	return clamped;
}

function isToolExecutionLike(value: unknown): value is { toolName: string; toolCallId: string } {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.toolName === "string" && typeof candidate.toolCallId === "string";
}

const AGENT_FAMILY_TOOL_NAMES = new Set(["Agent", "Agents", "get_subagent_result", "steer_subagent"]);

function isAgentFamilyToolName(name: unknown): boolean {
	return typeof name === "string" && AGENT_FAMILY_TOOL_NAMES.has(name);
}

function isTerminalImageLine(line: string): boolean {
	return line.includes(KITTY_IMAGE_PREFIX) || line.includes(ITERM2_IMAGE_PREFIX);
}

function normalizeLeadingCheckGlyph(line: string): string {
	return line.replace(/^((?:\x1b\[[0-9;]*m|[ \t]|[├└╰│─])*)[✔]((?:\x1b\[[0-9;]*m)*)(?=\s)/, "$1✓$2");
}

function stripOuterBackgroundAnsi(line: string): string {
	return line
		.replace(/^\x1b\[(?:49|4[0-7]|10[0-7]|48;5;\d+|48;2;\d+;\d+;\d+)m/, "")
		.replace(/\x1b\[49m$/, "");
}

function firstImageBlockStart(lines: string[]): number {
	const imageLineIndex = lines.findIndex(isTerminalImageLine);
	if (imageLineIndex === -1) return -1;
	let start = imageLineIndex;
	while (start > 0 && isBlankLine(lines[start - 1])) start--;
	return start;
}

function splitRenderedImageBlock(lines: string[]): { textLines: string[]; imageLines: string[] } {
	const imageStart = firstImageBlockStart(lines);
	if (imageStart === -1) return { textLines: lines, imageLines: [] };
	const textLines = lines.slice(0, imageStart);
	while (textLines.length > 0 && isBlankLine(textLines[textLines.length - 1])) textLines.pop();
	return { textLines, imageLines: lines.slice(imageStart) };
}

function toolGroupingEnabled(): boolean {
	return readSettings().groupToolCalls !== false;
}

function setToolGroupingEnabled(enabled: boolean): void {
	writeSettingsKey("groupToolCalls", enabled);
}

type ThinkingMode = "live" | "full";

function getThinkingMode(): ThinkingMode {
	return getMode(readSettings().thinkingMode, ["live", "full"] as const, "live");
}

function isAssistantThinkingComplete(comp: any, message: any): boolean {
	if (!message || message.role !== "assistant") return false;
	if (typeof message[THINKING_DURATION_KEY] === "number") return true;
	if (message[THINKING_ACTIVE_KEY]) return false;
	// Providers keep stopReason "pending" for the whole stream ("deferred" while
	// a deferred call is unresolved); both are in-flight sentinels, never
	// completion signals. Without this, live-thinking detection would depend on
	// THINKING_ACTIVE_KEY being stamped before the UI renders the same event.
	if (message.stopReason === "pending" || message.stopReason === "deferred") return false;
	if (typeof message.stopReason === "string" && message.stopReason.length > 0) return true;
	if (Array.isArray(message.content)) {
		let sawThinking = false;
		for (const block of message.content) {
			if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
				sawThinking = true;
			} else if (sawThinking && (
				(block?.type === "text" && typeof block.text === "string" && block.text.trim()) ||
				block?.type === "toolCall"
			)) {
				return true;
			}
		}
		if (sawThinking) return false;
	}
	return true;
}

function isLiveThinkingMessage(comp: any, message: any): boolean {
	if (!message || message.role !== "assistant") return false;
	if (isAssistantThinkingComplete(comp, message)) return false;
	if ((message as any)[THINKING_ACTIVE_KEY]) return true;
	if (Array.isArray(message.content)) {
		return message.content.some((b: any) => b?.type === "thinking" && typeof b?.thinking === "string" && b.thinking.trim());
	}
	return false;
}

type ToolStatus = "pending" | "success" | "error";

function getToolStatusForGroup(tool: any): ToolStatus {
	if (tool?.result?.isError) return "error";
	if (tool?.result && tool?.isPartial !== true) return "success";
	// Only in-flight tools that actually started this agent run count as pending.
	// History rows reconstructed without a matching toolResult stay isPartial=true
	// forever; treating them as pending made interrupted tools blink again on resume.
	if (tool?.isPartial === true && tool?.executionStarted === true && currentAgentWorkStartMs !== undefined) {
		return "pending";
	}
	return "success";
}

let TOOL_STATUS_SUCCESS = "\x1b[32m";
let TOOL_STATUS_ERROR = "\x1b[31m";
let TOOL_STATUS_PENDING = "\x1b[90m";

function getToolName(tool: any): string {
	return typeof tool?.toolName === "string" && tool.toolName ? tool.toolName : "tool";
}

// Claude Code: solid filled circle that is either fully present or fully gone
// while pending — never a hollow outlined ○. Classic ● + bold is the sweet
// spot for ordinary tools. Agent-family tools use a breathing size cycle.
const STATUS_DOT_FILLED = "●";
const STATUS_DOT_BOLD = "\x1b[1m";
// Single-cell glyphs only (⬤ is often double-width and walks the baseline).
// Optical sizes share the same cell so the center stays put while breathing:
// big ● → medium • → small · → invisible → small · → medium •
const AGENT_BREATHE_GLYPHS = ["●", "•", "·", " ", "·", "•"] as const;
const AGENT_BREATHE_LEN = AGENT_BREATHE_GLYPHS.length;

function paintStatusDot(colorAnsi: string): string {
	return `${colorAnsi}${STATUS_DOT_BOLD}${STATUS_DOT_FILLED}${TRANSPARENT_RESET}`;
}

/**
 * Pending indicator for individual tool calls. Default is the circle-breathe cycle (big ● →
 * • → · → invisible → · → •); `pendingIndicator: "spinner"` uses a single-cell braille
 * spinner and `"dot"` restores the classic on/off ●. Frames come from the wall clock (not
 * from a frame counter), so grouped rows and native rows show the same frame no matter
 * which of them happened to repaint last. Group headers do not use this: their light is a
 * steady ●, because their label already animates.
 */
const SPINNER_FRAMES = ["⠃", "⠉", "⠘", "⠰", "⢠", "⣀", "⡄", "⠆"] as const;
/** Spinner cadence; also the repaint beat while a spinner is pending. */
const SPINNER_INTERVAL_MS = 80;
/** One breathe step per beat — same cadence agent-family rows have always used. */
const BREATHE_INTERVAL_MS = 500;

function pendingIndicatorMode(): "breathe" | "spinner" | "dot" {
	const raw = readSettings().pendingIndicator;
	return raw === "spinner" || raw === "dot" ? raw : "breathe";
}

/** On/off phase of the classic blinking dot, read from the clock so any repaint agrees. */
function blinkPhaseOn(): boolean {
	return Math.floor(Date.now() / BREATHE_INTERVAL_MS) % 2 === 0;
}

function spinnerFrameGlyph(): string {
	const frames = SPINNER_FRAMES.length;
	const index = Math.floor(Date.now() / SPINNER_INTERVAL_MS) % frames;
	return SPINNER_FRAMES[(index + frames) % frames];
}

/** Colored pending light: breathe (default), braille spinner, or the blinking ●. */
function paintPendingLight(colorAnsi: string): string {
	const mode = pendingIndicatorMode();
	if (mode === "spinner") return `${colorAnsi}${spinnerFrameGlyph()}${TRANSPARENT_RESET}`;
	if (mode === "dot") return blinkPhaseOn() ? paintStatusDot(colorAnsi) : " ";
	return paintAgentBreatheDot(colorAnsi);
}

function themeStatusDot(theme: Theme, colorKey: "success" | "error" | "dim" | "muted"): string {
	// theme.fg may not preserve nested SGR cleanly — color the glyph string itself.
	return theme.fg(colorKey, `${STATUS_DOT_BOLD}${STATUS_DOT_FILLED}`);
}

function agentBreatheGlyphRaw(): string {
	// Always exactly one display cell — matches ordinary tool dots, keeps titles aligned.
	// Clock-driven so a repaint from any path lands on the same step.
	const frames = AGENT_BREATHE_LEN;
	const index = Math.floor(Date.now() / BREATHE_INTERVAL_MS) % frames;
	return AGENT_BREATHE_GLYPHS[(index + frames) % frames];
}

function paintAgentBreatheDot(colorAnsi: string = TOOL_STATUS_SUCCESS): string {
	const glyph = agentBreatheGlyphRaw();
	if (glyph === " ") return " ";
	// Bold only on the largest frame so weight changes without shifting the cell.
	const bold = glyph === "●" ? STATUS_DOT_BOLD : "";
	return `${colorAnsi}${bold}${glyph}${TRANSPARENT_RESET}`;
}

function agentBreatheDot(theme: Theme): string {
	const glyph = agentBreatheGlyphRaw();
	if (glyph === " ") return " ";
	const bold = glyph === "●" ? STATUS_DOT_BOLD : "";
	return theme.fg("success", `${bold}${glyph}`);
}

function groupStatusLight(status: ToolStatus, options?: { agentBreathe?: boolean }): string {
	const color = status === "success" ? TOOL_STATUS_SUCCESS : status === "error" ? TOOL_STATUS_ERROR : TOOL_STATUS_PENDING;
	if (status === "pending") {
		// Agent work always breathes; everyone else follows the configured pending light.
		// (Breathe and spinner are both clock-driven, so header and rows agree.)
		if (options?.agentBreathe) return paintAgentBreatheDot(TOOL_STATUS_SUCCESS);
		return paintPendingLight(TOOL_STATUS_SUCCESS);
	}
	return `${color}${status === "error" ? "!" : "✓"}${TRANSPARENT_RESET}`;
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripGroupedToolLabel(line: string, label: string | undefined): string {
	if (!label) return line;
	const ansi = "(?:\\x1b\\[[0-9;]*m)*";
	const pattern = new RegExp(`^(${ansi})${escapeRegex(label)}(${ansi})\\s+`);
	return line.replace(pattern, "$1$2");
}

function isChromeOnlyLine(line: string): boolean {
	const plain = stripAnsi(line).trim();
	return plain.length === 0 || /^[─━╭╮╰╯┌┐└┘│├┤┬┴┼\s]+$/.test(plain);
}

function stripToolChrome(lines: string[], preserveDiffRules = false): string[] {
	return trimRenderedBlankLines(lines).filter((line) => {
		if (!isChromeOnlyLine(line)) return true;
		return preserveDiffRules && /─{5,}/.test(stripAnsi(line));
	});
}

function stripLeadingToolStatus(line: string): string {
	// Drop the single-cell status marker so group rows can re-prefix a fresh light.
	// Include Agent breathe glyphs (·) and the blank off-phase (space) so the title
	// never keeps a leftover marker that shifts when size changes.
	return line.replace(
		/^((?:\x1b\[[0-9;]*m|[ \t]|[├└╰│─])*)(?:\x1b\[[0-9;]*m)*(?:[●○✗■⬤•·✓✔!\u2800-\u28FF]| )(?:\x1b\[[0-9;]*m)*\s+/,
		"$1",
	);
}

function trimAnsiLeft(text: string): string {
	let current = text;
	while (true) {
		const next = current.replace(/^((?:\x1b\[[0-9;]*m)*)[ \t]+/, "$1");
		if (next === current) return current;
		current = next;
	}
}

function removeGroupedToolPrefix(line: string, groupedLabel?: string): string {
	return trimAnsiLeft(stripGroupedToolLabel(trimAnsiLeft(stripLeadingToolStatus(line)), groupedLabel));
}

function getToolArgSummary(tool: any): string {
	const args = tool?.args ?? {};
	const name = getToolName(tool);
	try {
		return getToolArgSummaryUnsafe(args, name);
	} catch {
		// Malformed tool args must never crash the render loop.
		return "";
	}
}

// PTC tools (persistent Python sessions). `code_execution` is the pre-refactor
// name, kept so older installs still summarize correctly.
const PTC_CODE_TOOLS = new Set(["code_execution", "python_exec"]);

function summarizePtcToolCall(name: string, args: any): string | undefined {
	if (PTC_CODE_TOOLS.has(name)) {
		return summarizeText(String(args?.code ?? "").trim().split("\n")[0] ?? "", 100);
	}
	if (name === "provision_python_session") {
		const script = String(args?.script ?? "").trim();
		return script ? summarizeText(script, 100) : "new session";
	}
	if (name === "python_session_to_script") {
		const target = String(args?.path ?? args?.name ?? "").trim();
		return target ? summarizeText(target, 100) : "export session";
	}
	return undefined;
}

function getToolArgSummaryUnsafe(args: any, name: string): string {
	const ptc = summarizePtcToolCall(name, args);
	if (ptc !== undefined) return ptc;
	if (name === "read") {
		let value = shortPath(process.cwd(), args.path ?? "");
		const parts: string[] = [];
		if (args.offset) parts.push(`offset=${args.offset}`);
		if (args.limit) parts.push(`limit=${args.limit}`);
		if (parts.length > 0) value += ` (${parts.join(", ")})`;
		return value;
	}
	if (name === "bash") return buildBashCommandPresentation(args.command ?? "").headline;
	if (name === "grep") return `"${summarizeText(args.pattern ?? "", 40)}"${args.path ? ` in ${args.path}` : ""}`;
	if (name === "find") return `"${summarizeText(args.pattern ?? "", 40)}"${args.path ? ` in ${args.path}` : ""}`;
	if (name === "ls") return shortPath(process.cwd(), args.path ?? ".");
	return summarizeText(getStringArg(args, "path", "file_path", "url", "query", "name", "subject", "tool", "description", "prompt") || name, 72);
}

function getToolCallLine(tool: any): string {
	const value = (tool as any)?.callRendererComponent?.value;
	if (typeof value === "string" && value.trim()) {
		const line = value.split("\n").find((line) => stripAnsi(line).trim()) ?? value;
		return line.replaceAll(WRAP_MARK, "").replaceAll(CLIP_MARK, "");
	}
	const summary = getToolArgSummary(tool);
	return `${getToolName(tool)}${summary ? ` ${summary}` : ""}`;
}

function alignTrailingMarkedLine(line: string, width: number): string {
	const markerIndex = line.indexOf(TRAILING_MARK);
	if (markerIndex === -1) return clampLineWidth(line, width);
	const safeWidth = Math.max(1, width);
	const left = line.slice(0, markerIndex);
	const right = line.slice(markerIndex + TRAILING_MARK.length);
	const rightWidth = visibleWidth(right);
	if (rightWidth >= safeWidth) return truncateToWidth(right, safeWidth, "", false);
	const leftBudget = Math.max(0, safeWidth - rightWidth - 2);
	const clippedLeft = leftBudget > 0 ? truncateToWidth(left, leftBudget, "…", false) : "";
	const gap = Math.max(1, safeWidth - visibleWidth(clippedLeft) - rightWidth);
	return `${clippedLeft}${" ".repeat(gap)}${right}`;
}

function getCompactToolLine(tool: any, width: number, groupedLabel?: string, showTrailing = true): string {
	let content = removeGroupedToolPrefix(getToolCallLine(tool), groupedLabel);
	if (!showTrailing) content = content.split(TRAILING_MARK, 1)[0] ?? content;
	return alignTrailingMarkedLine(content || getToolName(tool), width);
}

interface ActivityTreeRow {
	kind: "activity" | "content";
	lines: string[];
	/** Thinking wall-clock for this run, so group headers can include it. */
	durationMs?: number;
}

const thinkingBodyCache = new WeakMap<object, { text: string; body: ThinkingParagraph }>();
const THINKING_EXPANDED_KEY = Symbol("pi-tool-tree:thinking-expanded");

function thinkingChild(component: any): boolean {
	// Newer Pi wraps thinking in a MouseRegion; older versions use direct children.
	if (component?.child) return thinkingChild(component.child);
	return component instanceof ThinkingParagraph || component instanceof HiddenThinkingSummary
		|| (isMarkdownComponent(component) && !!(component as any).defaultTextStyle?.italic)
		|| isHiddenThinkingPlaceholderText(component);
}

function thinkingRuns(message: any): Array<{ text: string; followedByActivity: boolean }> {
	const runs: Array<{ text: string; followedByActivity: boolean }> = [];
	const content = message?.content ?? [];
	for (let i = 0; i < content.length; i++) {
		if (content[i]?.type !== "thinking") continue;
		const texts: string[] = [];
		while (i < content.length && content[i]?.type === "thinking") {
			if (content[i].thinking?.trim()) texts.push(stripThinkingPresentationArtifacts(content[i].thinking));
			i++;
		}
		if (texts.length) runs.push({
			text: texts.join("\n\n"),
			followedByActivity: content.slice(i).some((block: any) => block?.type === "toolCall" || block?.text?.trim()),
		});
		i--;
	}
	return runs;
}

function assistantActivityRows(component: any, width: number): ActivityTreeRow[] {
	const message = component.lastMessage;
	const runs = thinkingRuns(message);
	if (runs.length === 0) return [{ kind: "content", lines: component.render(width) }];
	const rows: ActivityTreeRow[] = [];
	let runIndex = 0;
	for (const child of component.contentContainer?.children ?? []) {
		if (isSpacerComponent(child)) continue;
		if (!thinkingChild(child) || runIndex >= runs.length) {
			rows.push({ kind: "content", lines: applyTerminalCopyZones(child.render(width)) });
			continue;
		}
		const index = runIndex++;
		const run = runs[index];
		const live = !run.followedByActivity && index === runs.length - 1 && isLiveThinkingMessage(component, message);
		const duration = live && thinkingBlockStartMs > 0
			? Math.max(0, Date.now() - thinkingBlockStartMs)
			: getMessageThinkingDurationMs(message);
		const label = live ? `Thinking… ${formatThoughtDuration(duration)}` : `Thought for ${formatThoughtDuration(duration)}`;		const lines = [`${WORKED_LINE_FG}${label}${TRANSPARENT_RESET}`];
		const visibilityOverride = component.thinkingVisibilityOverrides?.get(index);
		// Pi's `hideThinkingBlock` is the user's "thinking is hidden" setting (Ctrl+T
		// / settings.json). When it is on, nothing streams either: every run renders
		// as its one-line `Thinking… Xs` / `Thought for Xs` summary. Per-run overrides
		// (explicitly expanding one thought) still win.
		const thinkingHidden = !!(component as any).hideThinkingBlock;
		const expanded = visibilityOverride
			?? (thinkingHidden ? false : (component[THINKING_EXPANDED_KEY] ?? (getThinkingMode() === "full" || live)));
		if (expanded) {
			let cached = thinkingBodyCache.get(child);
			if (!cached || cached.text !== run.text) {
				cached = { text: run.text, body: new ThinkingParagraph(run.text, component.markdownTheme) };
				thinkingBodyCache.set(child, cached);
			}
			// Render the body without the ∴ gutter; the tree supplies its own gutter.
			// (Column-slicing the gutter line drags its trailing ANSI reset into the
			// kept text, turning the first body line back to the default color.)
			const bodyWidth = Math.max(1, width - 5);
			lines.push(...cached.body.render(bodyWidth, { noGutter: true }));
		}
		rows.push({ kind: "activity", lines, durationMs: duration });
	}
	return rows;
}

function toolKeepsDisplayInActivityTree(tool: any): boolean {
	const name = getToolName(tool);
	return name === "edit" || name === "write";
}

// The outer tree uses ` glyph ` for both first and continuation rows. Keeping
// both prefixes the same width aligns mutation previews with their tool row.
const ACTIVITY_TREE_CHILD_CHROME_WIDTH = 3;
const TOOL_SHELL_HORIZONTAL_CHROME_WIDTH = 2;

function toolActivityLines(tool: any, width: number): string[] {
	const childWidth = Math.max(1, width - ACTIVITY_TREE_CHILD_CHROME_WIDTH);
	const status = getToolStatusForGroup(tool);
	const keepsDisplay = toolKeepsDisplayInActivityTree(tool);
	if (keepsDisplay && tool?.rendererState && typeof tool.rendererState === "object") {
		// Tool renderers normally learn their width only after returning a component.
		// In an activity group that first pass used the whole terminal, so a split diff
		// was built before the outer tree prefix and the tool shell padding were known.
		// Seed the exact component budget before renderCall/renderResult chooses a mode.
		// Only when it actually changes: re-seeding the same value every frame churns the
		// renderer state and, with the activity memo, would look like a content change.
		const diffWidth = Math.max(1, childWidth - TOOL_SHELL_HORIZONTAL_CHROME_WIDTH);
		if (tool.rendererState._diffComponentWidth !== diffWidth) {
			tool.rendererState._diffComponentWidth = diffWidth;
			_activityContentEpoch++;
		}
	}
	// Edits and writes are the model's proposed file changes, not incidental output:
	// keep their preview below the call after settlement. The group's continuation
	// rail is then drawn beside every preview row until the next item in the cluster.
	const showDetails = keepsDisplay
		|| tool.expanded === true
		|| (tool.isPartial === true && tool.executionStarted === true);
	// Rendering the actual tool component preserves native partial-result animations.
	// Never memoize an active component: its animation can change without new text.
	let lines = showDetails ? stripToolChrome(tool.render(childWidth), keepsDisplay) : [getCompactToolLine(tool, childWidth)];
	if (lines.length === 0) lines = [getCompactToolLine(tool, childWidth)];
	if (keepsDisplay) {
		// The default tool shell contributes two leading cells to result rows. The
		// grouped tree supplies that indentation itself, so remove the shell padding
		// and let the preview rail descend directly from the tool's status mark.
		for (let i = 1; i < lines.length; i++) lines[i] = trimAnsiLeft(lines[i]);
	}
	lines[0] = `${groupStatusLight(status, { agentBreathe: isAgentFamilyToolName(getToolName(tool)) })} ${removeGroupedToolPrefix(lines[0])}`;
	return lines;
}

/** Activity labels group neighboring tool calls into model-named phases. */
const ACTIVITY_PARAM = "activity";
const ACTIVITY_WRAPPED = Symbol.for("pi-tool-tree:activity-wrapped");
/**
 * Opt-in integration key other tool plugins use to apply the activity param.
 * Kept for plugins written before the query API existed; it resolves to the same
 * object as `TOOL_TREE_API_KEY`.
 */
const ACTIVITY_API_KEY = Symbol.for("pi-tool-tree:activity-api");
const DEFAULT_ACTIVITY_LABEL = "working";

/**
 * Running group labels sweep a highlight band across the text (the Claude Code /
 * ChatGPT "working" shimmer). Time-based rather than frame-based so the motion is
 * uniform no matter how often the TUI re-renders.
 *
 * The band's color is the active theme's color for the *current thinking level*, so a live
 * label is tinted by how hard the model is being asked to think and follows /thinking,
 * Shift+Tab, and model switches. The level color is used as-is: pushing it toward the
 * panel's emphasis color costs the chroma that makes it read as a palette color.
 */
const SHIMMER_PERIOD_MS = 1800;
/** Re-render cadence while a shimmering group is on screen (the ● blink stays 500ms). */
const SHIMMER_INTERVAL_MS = 80;
/** Highlight band half-width, as a fraction of the label length. */
const SHIMMER_BAND_RATIO = 0.65;
/** Mix toward the band color at the band's center: the level color itself. */
const SHIMMER_PEAK_MIX = 1;
/** Exponent on the cosine falloff; >1 keeps the tint in a hot core instead of a wash. */
const SHIMMER_FALLOFF_POW = 1.5;
/**
 * Minimum distance between the band and the label's own color. A muted level (or a level
 * color close to the theme's text) left the band indistinguishable from the label, so the
 * "sweep" read as a static word — the band always steps away from the label to keep at
 * least this much separation.
 */
const SHIMMER_MIN_BAND_DELTA = 72;
/** Pi thinking level -> theme color key (the same mapping pi uses for thinking borders). */
const THINKING_LEVEL_KEYS: Record<string, string> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};
/** `max` arrived after the other levels; older themes only define `thinkingXhigh`. */
const THINKING_LEVEL_COLOR_FALLBACKS: Record<string, string[]> = { max: ["thinkingXhigh"] };
/** Band color when no thinking level is known, or the theme has no color for it. */
const SHIMMER_FALLBACK_KEYS = ["accent", "borderAccent", "mdLink"];
/** How far the band color must sit from the label to read as a sweep at all. */
const SHIMMER_MIN_SWEEP_DELTA = 40;
/** pi's muted levels can match the panel color ("off"); the band needs at least this much. */
const SHIMMER_MIN_CONTRAST = 1.6;
/** Current pi thinking level, as reported by the session runtime. */
let _thinkingLevel: string | undefined;
/** Label base color when the active theme exposes no `text`/`muted` key. */
const DEFAULT_LABEL_FG = "\x1b[38;2;212;212;212m";

function activityGroupsEnabled(): boolean {
	return readSettings().activityGroups !== false;
}

function activityShimmerEnabled(): boolean {
	return readSettings().activityShimmer !== false;
}

/** True between the start of a run and `agent_end`: the agent is still on this request,
 *  even in the quiet stretches where nothing is streaming and no call is in flight. */
function agentWorking(): boolean {
	return typeof currentAgentWorkStartMs === "number";
}

function toolActivityParamEnabled(): boolean {
	return readSettings().toolActivityParam !== false;
}

function normalizeActivityLabel(raw: unknown): string {
	if (typeof raw !== "string") return "";
	return raw.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 24);
}

function activityLabelOf(tool: any): string {
	return normalizeActivityLabel(tool?.args?.[ACTIVITY_PARAM]);
}

/** Live tool durations for group headers. Lost on restart (Pi doesn't persist them). */
const TOOL_TIMINGS = new Map<string, { start: number; end?: number }>();
/**
 * Highest elapsed time a group's header reached while the chunk was live, keyed by the
 * group's first call. Transcripts re-render from scratch on every frame, so without this
 * a closed chunk would fall back to the sum of its recorded spans and visibly shrink the
 * moment prose arrived. Also lost on restart, like the timings it is measured from.
 */
const GROUP_ELAPSED_HIGH_WATER = new Map<string, number>();

/**
 * Wall-clock start of a live chunk, recorded the first time the group renders live.
 *
 * A running group ticks against real time, but the rows it sums are re-measured on
 * every render: several thinking rows can share one in-flight block, and a chatty
 * provider keeps the text-length fallback growing with the stream. Summing those
 * made the header climb many times faster than the clock ("20 seconds per second"),
 * so the live value comes from this single anchor instead.
 */
const GROUP_WALL_START = new Map<string, number>();

function liveGroupSpanMs(toolCallId: string, seedMs: number): number {
	const now = Date.now();
	let start = GROUP_WALL_START.get(toolCallId);
	if (start === undefined) {
		if (GROUP_WALL_START.size > 4096) {
			let dropped = 0;
			for (const key of GROUP_WALL_START.keys()) {
				GROUP_WALL_START.delete(key);
				if (++dropped >= 1024) break;
			}
		}
		start = now - Math.max(0, seedMs);
		GROUP_WALL_START.set(toolCallId, start);
	}
	return Math.max(0, now - start);
}

function recordGroupElapsed(toolCallId: string, ms: number): void {
	if (GROUP_ELAPSED_HIGH_WATER.size > 4096) {
		let dropped = 0;
		for (const key of GROUP_ELAPSED_HIGH_WATER.keys()) {
			GROUP_ELAPSED_HIGH_WATER.delete(key);
			if (++dropped >= 1024) break;
		}
	}
	GROUP_ELAPSED_HIGH_WATER.set(toolCallId, Math.max(GROUP_ELAPSED_HIGH_WATER.get(toolCallId) ?? 0, ms));
}

function recordToolStart(toolCallId: string): void {
	if (TOOL_TIMINGS.size > 4096) {
		let dropped = 0;
		for (const key of TOOL_TIMINGS.keys()) {
			TOOL_TIMINGS.delete(key);
			if (++dropped >= 1024) break;
		}
	}
	TOOL_TIMINGS.set(toolCallId, { start: Date.now() });
}

function recordToolEnd(toolCallId: string): void {
	const record = TOOL_TIMINGS.get(toolCallId);
	if (record) record.end = Date.now();
}

/** Add the required `activity` param to a tool schema. Returns undefined when the
 *  schema shape can't safely carry it (then the tool is left unwrapped). */
function withActivityParam(parameters: any): any | undefined {
	if (!parameters || typeof parameters !== "object") return undefined;
	if (parameters.type !== "object" || !parameters.properties || typeof parameters.properties !== "object") return undefined;
	if (parameters.properties[ACTIVITY_PARAM]) return parameters;
	if (Array.isArray(parameters.required) && parameters.required.includes(ACTIVITY_PARAM)) return parameters;
	return {
		...parameters,
		properties: {
			...parameters.properties,
			[ACTIVITY_PARAM]: Type.String({
				description:
					"Always include one or two lowercase words naming the activity this call belongs to " +
					"(e.g. exploring, implementing, testing). Reuse the previous call's word when continuing " +
					"the same activity.",
				default: DEFAULT_ACTIVITY_LABEL,
			}),
		},
		// Deliberately NOT appended to `required`: the wrapper defaults a missing label
		// in `prepareArguments`, so the tool never actually needs it — and consumers that
		// re-validate arguments against the advertised schema (pi-ptc-next mirrors these
		// parameters for its Python callables) would otherwise reject every call that
		// does not pass a label.
		required: Array.isArray(parameters.required) ? parameters.required : [],
	};
}

function stripActivityParam(args: any): any {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	if (!(ACTIVITY_PARAM in args)) return args;
	const { [ACTIVITY_PARAM]: _removed, ...rest } = args;
	return rest;
}

/** Wrap a tool definition so the model tags each call with an activity label.
 *  The label lives in the recorded args (survives resume); execution never sees it. */
function wrapWithActivity(record: any): any {
	if (!record || typeof record !== "object" || record[ACTIVITY_WRAPPED]) return record;
	const parameters = withActivityParam(record.parameters);
	if (!parameters) return record;
	const originalExecute = record.execute;
	const originalPrepare = typeof record.prepareArguments === "function" ? record.prepareArguments : undefined;
	return {
		...record,
		parameters,
		prepareArguments(args: any) {
			const prepared = originalPrepare ? originalPrepare(args) : args;
			const base = prepared && typeof prepared === "object" && !Array.isArray(prepared) ? prepared : {};
			const label = typeof base[ACTIVITY_PARAM] === "string" && base[ACTIVITY_PARAM].trim() ? base[ACTIVITY_PARAM] : DEFAULT_ACTIVITY_LABEL;
			// Return a copy: validation always sees a label, while the recorded
			// tool-call arguments stay exactly what the model sent.
			return { ...base, [ACTIVITY_PARAM]: label };
		},
		async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
			return originalExecute(toolCallId, stripActivityParam(params), signal, onUpdate, ctx);
		},
		[ACTIVITY_WRAPPED]: true,
	};
}

/**
 * Public API for other extensions: the opt-in activity-label hook plus a
 * read-only view of what the session is doing.
 *
 * `pi.getAllTools()` only exposes ToolInfo (name/description/parameters — no
 * `execute`), so the activity param cannot be swept onto tools this extension
 * does not own. A plugin opts in by wrapping its own definition before
 * registering it:
 *
 *   const activity = (globalThis as any)[Symbol.for("pi-tool-tree:api")];
 *   pi.registerTool(activity?.wrapTool ? activity.wrapTool(tool) : tool);
 *
 * `wrapTool` is a no-op when the `toolActivityParam` setting is off, so plugins
 * can call it unconditionally.
 *
 * The same object answers what the session is doing right now (`getActivity`),
 * what it has done so far (`getStats`), and when either changes (`subscribe`).
 * State is fed by pi's own events rather than by the transcript renderer, so it
 * is correct in hosts that never paint the grouped rows (RPC, headless, tests)
 * and never depends on a component being on screen. Durations are measured to
 * the moment a getter or listener runs, so a status line can poll them on its
 * own repaint cadence. Full reference: API.md.
 */
/** Canonical key. `pi-tool-tree:activity-api` is the key the label hook shipped
 *  with and resolves to the same object, so existing plugins keep working. */
const TOOL_TREE_API_KEY = Symbol.for("pi-tool-tree:api");

/** What the agent is doing. `idle` has no run in flight; `waiting` has one but
 *  nothing is streaming (awaiting the model, or between calls). */
type ActivityPhase = "idle" | "waiting" | "thinking" | "responding" | "tool";

/** A tool call that is executing right now. */
interface ActivityRunningCall {
	toolCallId: string;
	toolName: string;
	/** Activity label in effect when the call started. */
	label: string;
	/** Short single-line preview of the call's first meaningful argument,
	 *  for external consumers like the PTC subagent viewer. */
	argPreview?: string;
	/** Epoch milliseconds. */
	startedAt: number;
	/** Milliseconds this call has been running, measured to this call. */
	elapsedMs: number;
}

/** Counters for the current agent run. All zero while idle. */
interface ActivityRunStats {
	startedAt: number | null;
	/** Wall time since the run started. */
	elapsedMs: number;
	turns: number;
	/** Calls started in this run, including the ones still running. */
	toolCalls: number;
	toolCallsRunning: number;
	toolCallsFailed: number;
	/** Summed call spans, including running calls measured to this call. Parallel
	 *  calls each contribute their own span, so this can exceed the run's wall time. */
	toolMs: number;
	/** Summed reasoning time, including a block that is still streaming. */
	thinkingMs: number;
}

/** A point-in-time answer to "what is happening right now". */
interface ActivitySnapshot {
	phase: ActivityPhase;
	/** A run is in flight (equivalent to `phase !== "idle"`). */
	isWorking: boolean;
	/** Reasoning is streaming right now. */
	isThinking: boolean;
	/** At least one tool call is executing right now. */
	isRunningTool: boolean;
	/** Model-declared activity label for the current phase, e.g. "implementing".
	 *  Never null while working: a phase the model has not named yet reports
	 *  `defaultLabel`, and unlabeled calls inherit the previous label. */
	label: string | null;
	/** When the current label took effect. */
	labelStartedAt: number | null;
	/** Wall time spent on the current label, measured to this call. */
	labelElapsedMs: number;
	/** Calls started under the current label. */
	labelCalls: number;
	/** Start of the reasoning block that is streaming, or null. */
	thinkingStartedAt: number | null;
	thinkingElapsedMs: number;
	/** Calls executing right now, in start order. */
	calls: ActivityRunningCall[];
	run: ActivityRunStats;
}

interface ActivityToolStat {
	calls: number;
	failed: number;
	/** Milliseconds; only measured for calls made in this process. */
	durationMs: number;
}

interface ActivityLabelStat {
	calls: number;
	durationMs: number;
}

/** Cumulative statistics since the session began (resumed history included). */
interface ActivitySessionStats {
	/** Completed agent work: the sum of finished runs, idle time excluded. This is
	 *  the same number the transcript's `Total time` reports. */
	workedMs: number;
	runs: number;
	/** Turns across the finished runs of this session. */
	turns: number;
	/** Calls that finished, in this session and in resumed history. */
	toolCalls: number;
	toolCallsFailed: number;
	toolMs: number;
	thinkingMs: number;
	thinkingBlocks: number;
	byTool: Record<string, ActivityToolStat>;
	byLabel: Record<string, ActivityLabelStat>;
}

type ActivityChangeType =
	| "run-start"
	| "turn-start"
	| "label-change"
	| "thinking-start"
	| "thinking-end"
	| "stream-start"
	| "stream-end"
	| "tool-start"
	| "tool-end"
	| "run-end";

/** What changed, delivered alongside the resulting snapshot. */
interface ActivityChange {
	type: ActivityChangeType;
	toolCallId?: string;
	toolName?: string;
	/** Set on `label-change` and `tool-start`. */
	label?: string;
	/** Set on `tool-start`: one-line preview of the call's first argument. */
	argPreview?: string;
	/** Set on `tool-end`. */
	isError?: boolean;
	/** Set on `thinking-end`, `tool-end`, and `run-end`. */
	durationMs?: number;
	/** Set on `run-end`: the run that just finished. The snapshot is already idle,
	 *  so this is where a finished run's totals stay readable. */
	run?: ActivityRunStats;
}

type ActivityListener = (activity: ActivitySnapshot, change: ActivityChange) => void;

interface ActivityApi {
	/** Integration contract version for `wrapTool`. The query methods are
	 *  additive, so feature-detect them instead of branching on this. */
	version: 1;
	param: string;
	defaultLabel: string;
	enabled(): boolean;
	wrapTool<T extends object>(tool: T): T;
	getActivity(): ActivitySnapshot;
	getStats(): ActivitySessionStats;
	subscribe(listener: ActivityListener): () => void;
	/** The transcript's own duration formatting (`<1s`, `12s`, `3m 05s`, `1h 02m`). */
	formatDuration(ms: number): string;
}

interface ActivityCallState {
	toolCallId: string;
	toolName: string;
	label: string;
	startedAt: number;
	argPreview?: string;
}

const activityState = {
	/** Start of the run in flight, or null while idle. */
	runStartedAt: null as number | null,
	turns: 0,
	label: null as string | null,
	labelStartedAt: null as number | null,
	labelCalls: 0,
	/** Start of the reasoning block streaming right now, or null. */
	thinkingStartedAt: null as number | null,
	/** Reasoning finished within this run. */
	thinkingMs: 0,
	/** The model is streaming output right now (answer text or call arguments). */
	streaming: false,
	calls: new Map<string, ActivityCallState>(),
	toolCalls: 0,
	toolFailures: 0,
	toolMs: 0,
	listeners: new Set<ActivityListener>(),
	session: {
		runs: 0,
		turns: 0,
		toolCalls: 0,
		toolCallsFailed: 0,
		toolMs: 0,
		thinkingMs: 0,
		thinkingBlocks: 0,
		byTool: {} as Record<string, ActivityToolStat>,
		byLabel: {} as Record<string, ActivityLabelStat>,
	},
};

function bumpActivityToolStat(stats: Record<string, ActivityToolStat>, key: string, durationMs: number, failed: boolean): void {
	const entry = stats[key] ?? (stats[key] = { calls: 0, failed: 0, durationMs: 0 });
	entry.calls++;
	if (failed) entry.failed++;
	entry.durationMs += Math.max(0, durationMs);
}

function bumpActivityLabelStat(stats: Record<string, ActivityLabelStat>, key: string, durationMs: number): void {
	const entry = stats[key] ?? (stats[key] = { calls: 0, durationMs: 0 });
	entry.calls++;
	entry.durationMs += Math.max(0, durationMs);
}

function activityRunStats(now: number): ActivityRunStats {
	const started = activityState.runStartedAt;
	let liveToolMs = 0;
	for (const call of activityState.calls.values()) liveToolMs += Math.max(0, now - call.startedAt);
	const liveThinkingMs = activityState.thinkingStartedAt === null ? 0 : Math.max(0, now - activityState.thinkingStartedAt);
	return {
		startedAt: started,
		elapsedMs: started === null ? 0 : Math.max(0, now - started),
		turns: activityState.turns,
		toolCalls: activityState.toolCalls,
		toolCallsRunning: activityState.calls.size,
		toolCallsFailed: activityState.toolFailures,
		toolMs: activityState.toolMs + liveToolMs,
		thinkingMs: activityState.thinkingMs + liveThinkingMs,
	};
}

function activitySnapshot(): ActivitySnapshot {
	const now = Date.now();
	const calls = [...activityState.calls.values()].map((call) => ({
		toolCallId: call.toolCallId,
		toolName: call.toolName,
		label: call.label,
		startedAt: call.startedAt,
		elapsedMs: Math.max(0, now - call.startedAt),
	}));
	const thinking = activityState.thinkingStartedAt !== null;
	const phase: ActivityPhase = activityState.runStartedAt === null
		? "idle"
		: calls.length > 0
			? "tool"
			: thinking
				? "thinking"
				: activityState.streaming
					? "responding"
					: "waiting";
	return {
		phase,
		isWorking: activityState.runStartedAt !== null,
		isThinking: thinking,
		isRunningTool: calls.length > 0,
		label: activityState.label,
		labelStartedAt: activityState.labelStartedAt,
		labelElapsedMs: activityState.labelStartedAt === null ? 0 : Math.max(0, now - activityState.labelStartedAt),
		labelCalls: activityState.labelCalls,
		thinkingStartedAt: activityState.thinkingStartedAt,
		thinkingElapsedMs: thinking ? Math.max(0, now - (activityState.thinkingStartedAt as number)) : 0,
		calls,
		run: activityRunStats(now),
	};
}

function activitySessionStats(): ActivitySessionStats {
	const session = activityState.session;
	const byTool: Record<string, ActivityToolStat> = {};
	for (const [name, stat] of Object.entries(session.byTool)) byTool[name] = { ...stat };
	const byLabel: Record<string, ActivityLabelStat> = {};
	for (const [label, stat] of Object.entries(session.byLabel)) byLabel[label] = { ...stat };
	return {
		workedMs: Math.max(0, sessionWorkedTotalMs),
		runs: session.runs,
		turns: session.turns,
		toolCalls: session.toolCalls,
		toolCallsFailed: session.toolCallsFailed,
		toolMs: session.toolMs,
		thinkingMs: session.thinkingMs,
		thinkingBlocks: session.thinkingBlocks,
		byTool,
		byLabel,
	};
}

/** Tell subscribers what changed. The snapshot is built once per change and
 *  never handed out live, so listeners cannot corrupt tracked state — and a
 *  throwing listener must never take the agent down, so each call is guarded. */
function emitActivityChange(type: ActivityChangeType, detail: Omit<ActivityChange, "type"> = {}): void {
	if (activityState.listeners.size === 0) return;
	const activity = activitySnapshot();
	const change: ActivityChange = { type, ...detail };
	for (const listener of [...activityState.listeners]) {
		try {
			listener(activity, change);
		} catch { /* noop */ }
	}
}

/** A run is one prompt-to-answer cycle; `agent_end` closes it. Guarded so the
 *  `before_agent_start` / `agent_start` pair and steering injections (which can
 *  re-fire while the agent is busy) do not reset a run mid-flight. */
function activityStartRun(): void {
	if (activityState.runStartedAt !== null) return;
	const now = Date.now();
	activityState.runStartedAt = now;
	activityState.turns = 0;
	// Nothing has named this phase yet; the transcript's own fallback is `working`.
	activityState.label = DEFAULT_ACTIVITY_LABEL;
	activityState.labelStartedAt = now;
	activityState.labelCalls = 0;
	activityState.thinkingStartedAt = null;
	activityState.thinkingMs = 0;
	activityState.streaming = false;
	activityState.calls.clear();
	activityState.toolCalls = 0;
	activityState.toolFailures = 0;
	activityState.toolMs = 0;
	emitActivityChange("run-start");
}

function activityStartTurn(): void {
	if (activityState.runStartedAt === null) {
		// Hosts that never emit agent_start: the first turn is the run boundary.
		activityStartRun();
		activityState.turns = 1;
	} else {
		activityState.turns++;
	}
	emitActivityChange("turn-start");
}

function activityStartThinking(): void {
	if (activityState.thinkingStartedAt !== null) return;
	activityState.thinkingStartedAt = Date.now();
	emitActivityChange("thinking-start");
}

function activityEndThinking(): void {
	const started = activityState.thinkingStartedAt;
	if (started === null) return;
	const durationMs = Math.max(0, Date.now() - started);
	activityState.thinkingStartedAt = null;
	activityState.thinkingMs += durationMs;
	activityState.session.thinkingMs += durationMs;
	activityState.session.thinkingBlocks++;
	emitActivityChange("thinking-end", { durationMs });
}

function activityStartStreaming(): void {
	if (activityState.streaming) return;
	activityState.streaming = true;
	emitActivityChange("stream-start");
}

function activityEndStreaming(): void {
	if (!activityState.streaming) return;
	activityState.streaming = false;
	emitActivityChange("stream-end");
}

/** Reasoning streams from `thinking_start` to `thinking_end`, but some providers
 *  skip the end (or the start) marker. Any other stream event on the same
 *  message means reasoning is over, and a delta with no start means it began. */
function activityMessageUpdate(event: any): void {
	const evt = event?.assistantMessageEvent;
	const message = event?.message;
	if (!evt || typeof evt.type !== "string") return;
	if (message && typeof message === "object" && message.role !== "assistant") return;
	switch (evt.type) {
		case "thinking_start":
			activityStartThinking();
			return;
		case "thinking_delta":
			activityStartThinking();
			return;
		case "thinking_end":
			activityEndThinking();
			return;
		case "text_start":
		case "text_delta":
		case "toolcall_start":
		case "toolcall_delta":
			// Model output means reasoning is over, even without a thinking_end.
			activityEndThinking();
			activityStartStreaming();
			return;
		case "text_end":
		case "toolcall_end":
			activityEndStreaming();
			return;
		default:
			return;
	}
}

/** A new assistant message owns a fresh thinking/streaming lifecycle; a missing
 *  end marker on the previous one must not leak a phase into this one. */
function activityMessageStart(event: any): void {
	const message = event?.message;
	if (message && typeof message === "object" && message.role !== "assistant") return;
	activityEndThinking();
	activityEndStreaming();
}

function activityMessageEnd(event: any): void {
	const message = event?.message;
	if (message && typeof message === "object" && message.role !== "assistant") return;
	activityEndThinking();
	activityEndStreaming();
}

/** Resolve the phase label for a call: what the model declared, else the label
 *  already in effect (unlabeled calls continue the current group), else the
 *  transcript's fallback label. */
function activityResolveLabel(args: any): string {
	const declared = normalizeActivityLabel(args?.[ACTIVITY_PARAM]);
	if (declared) return declared;
	return activityState.label ?? DEFAULT_ACTIVITY_LABEL;
}

function activityToolStart(event: any): void {
	const toolCallId = typeof event?.toolCallId === "string" ? event.toolCallId : "";
	if (!toolCallId) return;
	// A call can only happen inside a run, but be forgiving: an extension loaded
	// mid-run (or a replayed event) should still report the call.
	if (activityState.runStartedAt === null) activityStartRun();
	const now = Date.now();
	const label = activityResolveLabel(event?.args);
	if (label !== activityState.label) {
		activityState.label = label;
		activityState.labelStartedAt = now;
		activityState.labelCalls = 0;
		emitActivityChange("label-change", { label });
	}
	activityState.labelCalls++;
	activityState.toolCalls++;
	const toolName = typeof event?.toolName === "string" && event.toolName ? event.toolName : "tool";
	const argPreview = activityArgPreview(event?.args);
	activityState.calls.set(toolCallId, { toolCallId, toolName, label, startedAt: now, argPreview });
	emitActivityChange("tool-start", { toolCallId, toolName, label, argPreview });
}

/** One-line preview of a tool call's arguments for external activity
 *  consumers: the first meaningful string argument, whitespace-flattened and
 *  trimmed. Never throws; undefined when nothing previewable is available. */
function activityArgPreview(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	try {
		for (const value of Object.values(args as Record<string, unknown>)) {
			if (typeof value === "string" && value.trim()) {
				const flat = value.replace(/\s+/g, " ").trim();
				return flat.length > 64 ? `${flat.slice(0, 61)}...` : flat;
			}
		}
	} catch {
		// preview is best-effort
	}
	return undefined;
}

function activityToolEnd(event: any): void {
	const toolCallId = typeof event?.toolCallId === "string" ? event.toolCallId : "";
	const call = toolCallId ? activityState.calls.get(toolCallId) : undefined;
	const isError = event?.isError === true;
	const toolName = call?.toolName
		?? (typeof event?.toolName === "string" && event.toolName ? event.toolName : "tool");
	const label = call?.label ?? activityState.label ?? DEFAULT_ACTIVITY_LABEL;
	const durationMs = call ? Math.max(0, Date.now() - call.startedAt) : 0;
	if (toolCallId) activityState.calls.delete(toolCallId);
	activityState.toolMs += durationMs;
	if (isError) activityState.toolFailures++;
	const session = activityState.session;
	session.toolCalls++;
	if (isError) session.toolCallsFailed++;
	session.toolMs += durationMs;
	bumpActivityToolStat(session.byTool, toolName, durationMs, isError);
	bumpActivityLabelStat(session.byLabel, label, durationMs);
	emitActivityChange("tool-end", { toolCallId, toolName, isError, durationMs });
}

function activityEndRun(): void {
	if (activityState.runStartedAt === null) return;
	// A call still in flight when the run ends never produced a result; settle it
	// as a failure so it is counted rather than silently dropped.
	for (const call of [...activityState.calls.values()]) {
		activityToolEnd({ toolCallId: call.toolCallId, toolName: call.toolName, isError: true });
	}
	activityEndThinking();
	activityEndStreaming();
	const run = activityRunStats(Date.now());
	activityState.session.runs++;
	activityState.session.turns += run.turns;
	activityState.runStartedAt = null;
	activityState.turns = 0;
	activityState.label = null;
	activityState.labelStartedAt = null;
	activityState.labelCalls = 0;
	activityState.toolCalls = 0;
	activityState.toolFailures = 0;
	activityState.toolMs = 0;
	activityState.thinkingMs = 0;
	emitActivityChange("run-end", { durationMs: run.elapsedMs, run });
}

/** Counters survive resume/reload: walked back from the active branch so
 *  `getStats()` reports the whole session, not just this process. Durations of
 *  calls made before this process start are unknown (they were never recorded),
 *  so call counts are seeded while call time is not; reasoning time is, because
 *  completed thinking blocks stamp their duration into the message. */
function seedActivitySession(messages: any[]): void {
	const session = activityState.session;
	session.runs = 0;
	session.turns = 0;
	session.toolCalls = 0;
	session.toolCallsFailed = 0;
	session.toolMs = 0;
	session.thinkingMs = 0;
	session.thinkingBlocks = 0;
	session.byTool = {};
	session.byLabel = {};
	// Calls are counted from the assistant's own `toolCall` blocks; a failed
	// `toolResult` marks that call as failed rather than counting a second call.
	const countedCalls = new Set<string>();
	let runTurns = 0;
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		if (message.role === "user") {
			runTurns = 0;
			continue;
		}
		if (message.role === "toolResult") {
			if (message.isError !== true) continue;
			session.toolCallsFailed++;
			const failedTool = typeof message.toolName === "string" && message.toolName ? message.toolName : "tool";
			const entry = session.byTool[failedTool] ?? (session.byTool[failedTool] = { calls: 0, failed: 0, durationMs: 0 });
			entry.failed++;
			// A result whose call is not in the branch (compacted or edited history)
			// still stands for a call that happened.
			const resultCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
			if (!resultCallId || !countedCalls.has(resultCallId)) entry.calls++;
			continue;
		}
		if (message.role !== "assistant") continue;
		runTurns++;
		for (const block of Array.isArray(message.content) ? message.content : []) {
			if (!block || typeof block !== "object") continue;
			if (block.type === "toolCall") {
				session.toolCalls++;
				if (typeof block.id === "string" && block.id) countedCalls.add(block.id);
				bumpActivityToolStat(session.byTool, typeof block.name === "string" && block.name ? block.name : "tool", 0, false);
				bumpActivityLabelStat(session.byLabel, normalizeActivityLabel(block.arguments?.[ACTIVITY_PARAM]) || DEFAULT_ACTIVITY_LABEL, 0);
				continue;
			}
			if (block.type !== "thinking") continue;
			const durationMs = message[THINKING_DURATION_KEY];
			if (typeof durationMs !== "number" || !(durationMs > 0)) continue;
			session.thinkingMs += durationMs;
			session.thinkingBlocks++;
		}
		if (message.stopReason !== "stop") continue;
		if (typeof message[WORKED_DURATION_KEY] !== "number") continue;
		session.runs++;
		const stamped = message[WORKED_TURNS_KEY];
		session.turns += typeof stamped === "number" && stamped > 0 ? stamped : runTurns;
	}
}

function activityResetRun(): void {
	activityState.runStartedAt = null;
	activityState.turns = 0;
	activityState.label = null;
	activityState.labelStartedAt = null;
	activityState.labelCalls = 0;
	activityState.thinkingStartedAt = null;
	activityState.thinkingMs = 0;
	activityState.streaming = false;
	activityState.calls.clear();
	activityState.toolCalls = 0;
	activityState.toolFailures = 0;
	activityState.toolMs = 0;
}

function activitySubscribe(listener: ActivityListener): () => void {
	if (typeof listener !== "function") return () => {};
	activityState.listeners.add(listener);
	let subscribed = true;
	return () => {
		if (!subscribed) return;
		subscribed = false;
		activityState.listeners.delete(listener);
	};
}

function publishActivityApi(): void {
	const api: ActivityApi = {
		version: 1,
		param: ACTIVITY_PARAM,
		defaultLabel: DEFAULT_ACTIVITY_LABEL,
		enabled: toolActivityParamEnabled,
		wrapTool: <T extends object>(tool: T): T => (toolActivityParamEnabled() ? wrapWithActivity(tool) : tool),
		getActivity: activitySnapshot,
		getStats: activitySessionStats,
		subscribe: activitySubscribe,
		formatDuration: formatBashDuration,
	};
	// One object, two keys: plugins written against either name share the same
	// state and subscriptions.
	(globalThis as any)[TOOL_TREE_API_KEY] = api;
	(globalThis as any)[ACTIVITY_API_KEY] = api;
}

/** Feed the tracker from pi's events and publish the API. Registered early so
 *  the object is in place before any tool registers or a run starts. */
function registerActivityApi(pi: ExtensionAPI): void {
	publishActivityApi();
	pi.on("before_agent_start", async () => { activityStartRun(); });
	pi.on("agent_start", async () => { activityStartRun(); });
	pi.on("turn_start", async () => { activityStartTurn(); });
	pi.on("message_start", async (event) => { activityMessageStart(event); });
	pi.on("message_update", async (event) => { activityMessageUpdate(event); });
	pi.on("message_end", async (event) => { activityMessageEnd(event); });
	pi.on("tool_execution_start", async (event) => { activityToolStart(event); });
	pi.on("tool_execution_end", async (event) => { activityToolEnd(event); });
	pi.on("agent_end", async () => { activityEndRun(); });
	// Rebuild counters from the active branch on resume/reload/fork, the same way
	// the transcript re-seeds its work totals.
	pi.on("session_start", async (_event, ctx) => {
		activityResetRun();
		const messages = sessionBranchMessages(ctx);
		if (messages) seedActivitySession(messages);
	});
	pi.on("session_shutdown", async () => {
		activityResetRun();
		activityState.listeners.clear();
	});
}

/** Tools this extension owns, kept as factories so `/cc-tools activity` can
 *  re-register them with or without the param without restarting pi. */
const coreToolFactories = new Map<string, () => any>();

function registerCoreTool(pi: ExtensionAPI, name: string, factory: () => any): void {
	coreToolFactories.set(name, factory);
	pi.registerTool(toolActivityParamEnabled() ? wrapWithActivity(factory()) : factory());
}

function reregisterCoreTools(pi: ExtensionAPI): void {
	for (const factory of coreToolFactories.values()) {
		pi.registerTool(toolActivityParamEnabled() ? wrapWithActivity(factory()) : factory());
	}
}

/**
 * Wall-clock start of an activity group, reconstructed by laying its recorded spans
 * end to end backwards from now. A live chunk's header duration is measured from here,
 * so it keeps ticking through the silent gaps between calls without ever double counting
 * a call that is still running.
 */
function groupChunkStartMs(items: { tool?: any; durationMs?: number }[]): number {
	let cursor = Date.now();
	let start = cursor;
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		const timing = item.tool ? TOOL_TIMINGS.get(item.tool.toolCallId) : undefined;
		if (timing) {
			// A pending call is still running, so it ends at the cursor.
			cursor = timing.end ?? cursor;
			start = Math.min(start, timing.start);
			continue;
		}
		if (typeof item.durationMs === "number" && item.durationMs >= 0) {
			cursor -= item.durationMs;
			start = Math.min(start, cursor);
			continue;
		}
		start = Math.min(start, cursor);
	}
	return Math.min(start, Date.now());
}

/** Render-only grouping: keep Pi's child identities, message data and order intact. */
function renderActivityTranscript(parent: any, width: number): string[] | undefined {
	if (!toolGroupingEnabled() || !Array.isArray(parent.children)) return undefined;
	if (!parent.children.some((child: any) => child instanceof ToolExecutionComponent || child instanceof AssistantMessageComponent)) return undefined;
	if (width <= 0) return [];

	// Rebuilding the grouped transcript is O(all lines) per repaint — and pi repaints on every
	// keystroke, so an idle session paid to re-measure a whole transcript it was not changing.
	// The output is a pure function of the children (identity + render flags), the width, the
	// theme/branch visuals and our own content epoch, so memoise it. Renders that find a live
	// group are never cached: those frames animate by definition.
	const memo = parent[ACTIVITY_RENDER_CACHE];
	if (
		// While a run is in flight this transcript animates by itself: live durations tick and the
		// trailing chunk shimmers, none of which shows up in the children or their flags. Never
		// reuse (or keep) a memo then — those frames exist to repaint.
		!agentWorking() &&
		memo &&
		memo.width === width &&
		memo.contentEpoch === _activityContentEpoch &&
		memo.branchEpoch === _toolBranchVisualEpoch &&
		memo.branchKey === toolBranchRenderCacheKey() &&
		memo.mode === toolBackgroundMode &&
		sameActivityChildren(parent.children, memo.children)
	) {
		return memo.lines;
	}

	type ToolEntry = { kind: "tool"; tool: any; label: string };
	type ThinkingEntry = { kind: "thinking"; lines: string[]; label: string; durationMs?: number };
	type ContentEntry = { kind: "content"; lines: string[]; trimEdges?: boolean; ambient?: boolean };
	type Entry = ToolEntry | ThinkingEntry | ContentEntry;

	// Pass 1: classify children (content renders once, here).
	const entries: Entry[] = [];
	for (const child of parent.children) {
		if (child instanceof ToolExecutionComponent) {
			entries.push({ kind: "tool", tool: child, label: activityGroupsEnabled() ? activityLabelOf(child) : "" });
			continue;
		}
		if (isSpacerComponent(child)) continue;
		// Only the conversation closes a chunk; everything else pi prints into the transcript
		// (status notices, warnings, help) is chrome that can land mid-run.
		const fromConversation =
			child instanceof AssistantMessageComponent ||
			child instanceof UserMessageComponent ||
			child instanceof CustomMessageComponent;
		const rows = child instanceof AssistantMessageComponent
			? assistantActivityRows(child, width)
			: [{ kind: "content" as const, lines: applyTerminalCopyZones(child.render(width)) }];
		for (const row of rows) {
			if (row.kind === "activity") entries.push({ kind: "thinking", lines: row.lines, label: "", durationMs: row.durationMs });
			else {
				// Empty assistant shells don't split a thinking/tool sequence.
				if (child instanceof AssistantMessageComponent && row.lines.every((line: string) => isBlankLine(line))) continue;
				// Only assistant rows get their edge padding trimmed — pi wraps every message in a
				// Spacer, but a user message pads itself with background-filled rows inside its Box,
				// and dropping those collapses the bubble to a single line.
				entries.push({ kind: "content", lines: row.lines, trimEdges: child instanceof AssistantMessageComponent, ambient: !fromConversation });
			}
		}
	}

	// Pass 2: resolve labels. Unlabeled tools continue the previous tool's group;
	// thinking belongs to the group of the call it precedes (a thought justifies
	// what comes next), falling back to the previous tool's group.
	let lastLabel = "";
	for (const entry of entries) {
		if (entry.kind !== "tool") continue;
		if (!entry.label) entry.label = lastLabel;
		lastLabel = entry.label;
	}
	// Where the conversation ends. pi splices non-conversation rows into the transcript
	// while a run is in flight — the `Thinking level: …` and `Switched to …` status notices
	// that Shift+Tab and Ctrl+P post, plus warnings and errors. Those are not the
	// conversation moving on, so they must not close the live chunk: doing that froze the
	// sweep, the duration ticks and the repaint loop mid-run.
	let lastConversationalIndex = -1;
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.kind !== "content" || entry.ambient !== true) lastConversationalIndex = index;
	}	lastLabel = "";
	for (const entry of entries) {
		if (entry.kind === "thinking") {
			let nextLabel: string | undefined;
			for (const later of entries.slice(entries.indexOf(entry) + 1)) {
				if (later.kind === "tool") {
					nextLabel = later.label;
					break;
				}
				if (later.kind === "content") break;
			}
			entry.label = nextLabel !== undefined ? nextLabel : lastLabel;
		} else if (entry.kind === "tool") {
			lastLabel = entry.label;
		}
	}

	// Pass 3: emit. Content flushes; consecutive equal-label activity runs form groups.
	const output: string[] = [];
	const margin = " ";
	const connector = activityTreeBranchAnsi();
	let pending: { label: string; lines: string[]; tool?: any; durationMs?: number }[] = [];
	// Whether this render found the transcript's trailing chunk still live. When it did
	// not, the loop armed by an earlier render is released at the end of this one.
	let armedLive = false;

	const emitGroup = (items: typeof pending, trailing: boolean): void => {
		const tools = items.filter((item) => item.tool);
		const statuses = tools.map((item) => getToolStatusForGroup(item.tool));
		const pendingCount = statuses.filter((status) => status === "pending").length;
		const failedCount = statuses.filter((status) => status === "error").length;
		// Only tool calls count as calls — a thought row is not a call.
		const count = tools.length;
		const color = failedCount > 0 ? TOOL_STATUS_ERROR : pendingCount > 0 ? TOOL_STATUS_PENDING : TOOL_STATUS_SUCCESS;
		// The header light is steady. Its label already animates (the shimmer sweep) and every
		// call row below carries the configured pending light, so a second animation on this
		// line only competes with the sweep. The color still reads pending (dim) → success
		// (green) / error (red).
		const dot = paintStatusDot(color);
		const parts: string[] = [];
		// An unlabeled call inherits the previous group's label (see pass 2). When there
		// is nothing to inherit — the first group of a run, a tool that never declared
		// `activity`, an MCP call — fall back to the default label instead of printing a
		// bare `3 calls` header.
		const label = items[0].label || (activityGroupsEnabled() ? DEFAULT_ACTIVITY_LABEL : "");
		if (label) parts.push(label);
		if (count > 0) parts.push(`${count} ${count === 1 ? "call" : "calls"}`);
		let totalMs = 0;
		let timed = 0;
		for (const item of tools) {
			const timing = TOOL_TIMINGS.get(item.tool.toolCallId);
			if (!timing) continue;
			timed++;
			// Pending calls tick against the wall clock, so a running call is always measured
			// to this frame; settled ones contribute the span they recorded.
			const end = timing.end ?? Date.now();
			totalMs += Math.max(0, end - timing.start);
		}
		// Thinking inside the group is time spent on that group, so it counts toward the
		// duration even though it is not a call. Without this a group whose tools are fast
		// advertises `<1s` after half a minute of reasoning.
		let thinkingMs = 0;
		let thought = 0;
		for (const item of items) {
			if (item.tool || typeof item.durationMs !== "number") continue;
			thought++;
			thinkingMs += Math.max(0, item.durationMs);
		}
		// The chunk is live while it is the last thing in the transcript and the agent is
		// still on this request: from the group's first call until prose follows it, a
		// different activity label supersedes it, or the run ends. Individual calls settling
		// does not close it — the agent is still thinking, or about to call again.
		const live = trailing && (agentWorking() || pendingCount > 0);
		// A live chunk ticks against one wall clock anchored when it first rendered live,
		// so it keeps counting between calls instead of freezing on the last measured
		// activity. The measured sum can only ever *lower* that live reading (its rows can
		// overlap — see GROUP_WALL_START), so it is capped by the wall span while live and
		// used as-is once the chunk settles and the rows no longer overlap. A closed chunk
		// keeps the highest value it reached: recomputing from the recorded spans alone
		// would make the total drop back on the next frame.
		const anchorId = tools.length > 0 ? tools[0].tool?.toolCallId : undefined;
		const measuredSumMs = totalMs + thinkingMs;
		const wallSpanMs = live
			? typeof anchorId === "string"
				? liveGroupSpanMs(anchorId, measuredSumMs)
				: Math.max(0, Date.now() - groupChunkStartMs(items))
			: 0;
		const boundedSumMs = live ? Math.min(measuredSumMs, wallSpanMs) : measuredSumMs;
		const measuredMs = live ? Math.max(boundedSumMs, wallSpanMs) : 0;
		if (live && typeof anchorId === "string") recordGroupElapsed(anchorId, measuredMs);
		const reachedMs = typeof anchorId === "string" ? (GROUP_ELAPSED_HIGH_WATER.get(anchorId) ?? 0) : 0;
		const elapsedMs = Math.max(boundedSumMs, measuredMs, reachedMs);
		// A reading of 0 still prints (`<1s`): a call that just started is a measurement,
		// while a group with no timing data at all prints none.
		if (timed > 0 || thought > 0) parts.push(formatBashDuration(elapsedMs));
		// While the chunk is live its label shimmers; once it closes the label returns to the
		// ambient color. The status light stays what it always was — a per-call indicator
		// that stops blinking the moment every individual call has settled. Counts are
		// static metadata either way.
		const shimmering = live && !!label && activityShimmerEnabled();
		// The transcript owns this row's light and label, so it also owns the repaint:
		// ~80ms while the sweep runs, 500ms for a bare live duration.
		if (live && count > 0) {
			armedLive = true;
			const running: any[] = [];
			for (let i = 0; i < tools.length; i++) {
				if (statuses[i] === "pending") running.push(tools[i].tool);
			}
			// Any row in the group can carry the repaint: a chunk in its thinking phase has
			// nothing in flight, and that is exactly when the clock needs the frames most.
			const carrier = running[0] ?? tools[0]?.tool;
			requestLiveGroupFrame(parent, () => {
				safeInvalidate(parent);
				for (const tool of running) safeInvalidate(tool);
				requestLiveRepaint(carrier);
			}, shimmering);
		}
		const labelAnsi = label ? (shimmering ? shimmerTextAnsi(label) : label) : "";
		// Secondary text: `N calls · 5s` uses the same theme-derived gray as the
		// `Thought for Xs` rows (branch chrome + OUTLINE_CHROME_BRIGHTEN) instead of the
		// dimmer body-gray, so it reads as metadata next to the label rather than vanishing.
		const labelAndCounts = `${labelAnsi}${labelAnsi ? " " : ""}${WORKED_LINE_FG}${parts.slice(label ? 1 : 0).join(" · ")}${TRANSPARENT_RESET}`;
		const header = `${margin}${dot}${TRANSPARENT_RESET} ${labelAndCounts}${
			failedCount > 0 ? ` ${TOOL_STATUS_ERROR}· ${failedCount} failed${TRANSPARENT_RESET}` : ""
		}`;
		// A run without tool calls has no group to head: emit its rows under the
		// previous block instead of a bare `label 0 calls` header.
		if (count > 0) output.push(clampLineWidth(header, width));
		items.forEach((item, index) => {
			const last = index === items.length - 1;
			const glyph = last ? "╰" : "├";
			const prefix = `${margin}${connector}${glyph}${TRANSPARENT_RESET} `;
			const continuation = `${margin}${connector}${last ? " " : "│"}${TRANSPARENT_RESET} `;
			item.lines.forEach((line, j) => {
				// Image protocol payloads must not be modified or truncated as text.
				output.push(isTerminalImageLine(line) ? line : clampLineWidth(`${j === 0 ? prefix : continuation}${line}`, width));
			});
		});
	};

	const flush = (finalFlush = false) => {
		const runs: typeof pending[] = [];
		for (const item of pending) {
			const last = runs[runs.length - 1];
			if (last && last[0].label === item.label) last.push(item);
			else runs.push([item]);
		}
		for (let i = 0; i < runs.length; i++) {
			separate();
			// Only the last group of the render still ends the transcript; anything flushed
			// earlier was closed by the prose or the different label that followed it.
			emitGroup(runs[i], finalFlush && i === runs.length - 1);
		}
		pending = [];
	};

	// Blank lines separate transcript blocks (agent prose vs. activity groups).
	const separate = () => {
		if (output.length > 0 && !isBlankTranscriptLine(output[output.length - 1])) output.push("");
	};

	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.kind === "content") {
			// A status notice pi splices in mid-run is the last row in the transcript but not the
			// conversation moving on, so the chunk before it is still the live one.
			flush(entry.ambient === true && index > lastConversationalIndex);
			// Assistant rows drop pi's own edge padding so block spacing stays uniform. Pi's
			// Markdown child can also overshoot at very small widths, so clamp every prose/native
			// line the same way grouped rows are clamped.
			const contentLines = entry.trimEdges ? trimBlankEdges(entry.lines) : entry.lines;
			if (contentLines.length === 0) continue;
			separate();
			output.push(...contentLines.map((line) => (isTerminalImageLine(line) ? line : clampLineWidth(line, width))));
			continue;
		}
		pending.push({
			label: entry.label,
			lines: entry.kind === "tool" ? toolActivityLines(entry.tool, width) : entry.lines,
			tool: entry.kind === "tool" ? entry.tool : undefined,
			durationMs: entry.kind === "thinking" ? entry.durationMs : undefined,
		});
	}
	flush(true);
	// Nothing in this transcript is live any more (prose, a closed chunk, or the run
	// ended): release the frame loop so it cannot outlive the animation.
	if (!armedLive) stopLiveGroupFrame(parent);
	if (!armedLive && !agentWorking()) {
		parent[ACTIVITY_RENDER_CACHE] = {
			width,
			contentEpoch: _activityContentEpoch,
			branchEpoch: _toolBranchVisualEpoch,
			branchKey: toolBranchRenderCacheKey(),
			mode: toolBackgroundMode,
			children: parent.children.slice(),
			lines: output,
		};
	} else {
		delete parent[ACTIVITY_RENDER_CACHE];
	}
	return output;
}

function isSpacerComponent(value: unknown): value is InstanceType<typeof Spacer> {
	return value instanceof Spacer || (value as any)?.constructor?.name === "Spacer";
}

function isTextComponent(value: unknown): value is InstanceType<typeof Text> {
	return value instanceof Text || (value as any)?.constructor?.name === "Text";
}

function isMarkdownComponent(value: unknown): value is InstanceType<typeof Markdown> {
	return value instanceof Markdown || (value as any)?.constructor?.name === "Markdown";
}

function patchContainerParentTracking(): void {
	const proto = Container.prototype as any;
	if (proto[PARENT_TRACKING_PATCH_FLAG]) return;
	const originalAddChild = proto.addChild;
	const originalRemoveChild = proto.removeChild;
	const originalClear = proto.clear;
	proto.addChild = function patchedAddChild(component: any) {
		const result = originalAddChild.call(this, component);
		if (component && typeof component === "object") component[COMPONENT_PARENT] = this;
		return result;
	};
	proto.removeChild = function patchedRemoveChild(component: any) {
		const result = originalRemoveChild.call(this, component);
		if (component && typeof component === "object" && component[COMPONENT_PARENT] === this) delete component[COMPONENT_PARENT];
		return result;
	};
	proto.clear = function patchedClear() {
		for (const child of this.children ?? []) {
			if (child && typeof child === "object" && child[COMPONENT_PARENT] === this) delete child[COMPONENT_PARENT];
		}
		return originalClear.call(this);
	};
	proto[PARENT_TRACKING_PATCH_FLAG] = true;
}

function formatTodoOverlayLines(lines: string[], width: number): string[] {
	// Hot path: nearly every Container.render hits this. Bail after the first
	// non-empty line unless it's actually the Magic Context todo overlay.
	let firstContent: string | undefined;
	for (let i = 0; i < lines.length; i++) {
		const plain = stripAnsi(lines[i]).trim();
		if (!plain) continue;
		firstContent = plain;
		break;
	}
	if (!firstContent || !/^[●○]\s+Todos\s+—/.test(firstContent)) return lines;
	return lines.map((line) => {
		const plain = stripAnsi(line);
		if (/^[●○]\s+Todos\s+—/.test(plain)) return clampLineWidth(` ${line}`, width);
		// Magic Context emits `├─` / `└─` or bare `├` / `└`; strip any arm to bare tee/corner.
		if (!/^[├└]─?\s+[✓○◐✗●⬤•]\s/.test(plain) && !/^[├└]─?\s+/.test(plain)) return line;
		const withoutTodoHash = line.replace(/#(?=[A-Za-z0-9_-]+)/, "");
		const bare = withoutTodoHash.replace(/([├└])─/, "$1");
		const colored = bare.replace(/[├└]/, (branch) => `${currentToolBranchAnsi()}${branch}${TRANSPARENT_RESET}`);
		return clampLineWidth(` ${colored}`, width);
	});
}

function patchGlobalToolBorders(): void {
	const proto = Container.prototype as any;
	if (proto[PATCH_FLAG]) return;

	const originalRender = proto.render;
	proto.render = function patchedContainerRender(width: number): string[] {
		if (isToolExecutionLike(this)) {
			const cached = (this as any)[TOOL_RENDER_CACHE];
			const branchKey = toolBranchRenderCacheKey();
			if (
				this.isPartial !== true
				&& cached?.width === width
				&& cached?.mode === toolBackgroundMode
				&& cached?.branchKey === branchKey
				&& cached?.branchEpoch === _toolBranchVisualEpoch
			) {
				return cached.lines;
			}
		}

		const rendered = renderActivityTranscript(this, width) ?? originalRender.call(this, width);
		if (!Array.isArray(rendered) || rendered.length === 0) return rendered;
		const todoOverlay = formatTodoOverlayLines(rendered, width);
		if (!isToolExecutionLike(this)) return todoOverlay;
		const branchCache = { branchKey: toolBranchRenderCacheKey(), branchEpoch: _toolBranchVisualEpoch };
		if (toolBackgroundMode === "default") {
			(this as any)[TOOL_RENDER_CACHE] = { width, mode: toolBackgroundMode, lines: rendered, ...branchCache };
			return rendered;
		}

		let start = 0;
		while (start < rendered.length && isBlankLine(rendered[start])) start++;
		let end = rendered.length - 1;
		while (end >= start && isBlankLine(rendered[end])) end--;
		if (start > end) return rendered;

		const { textLines, imageLines } = splitRenderedImageBlock(rendered.slice(start, end + 1));
		if (imageLines.length > 0) {
			(this as any)[TOOL_RENDER_CACHE] = { width, mode: toolBackgroundMode, lines: rendered, ...branchCache };
			return rendered;
		}
		// Agent-family tools stay column-aligned with every other tool row — no extra
		// leading indent (the old nested pad made Agent look offset from Read/Bash).
		const core = textLines.map((line) => {
			const normalized = normalizeLeadingCheckGlyph(line);
			return clampLineWidth(stripOuterBackgroundAnsi(normalized), width);
		});
		const spacerLine = " ".repeat(width);
		let result: string[];

		result = [spacerLine, ...core, ...imageLines];

		(this as any)[TOOL_RENDER_CACHE] = { width, mode: toolBackgroundMode, lines: result, ...branchCache };
		return result;
	};

	proto[PATCH_FLAG] = true;
}

function summarizeText(text: string, max = 60): string {
	const oneLine = text.replace(/\n/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	return `${oneLine.slice(0, Math.max(0, max - 3))}...`;
}

function hashText(text: string): string {
	let hash = 2166136261;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

let extraToolOutputExpanded = false;

function syncExtraToolDetailMode(): void {
	extraToolOutputExpanded = readSettings().extraToolOutputExpanded === true;
}

function setExtraToolDetailMode(enabled: boolean): void {
	extraToolOutputExpanded = enabled;
	writeSettingsKey("extraToolOutputExpanded", enabled);
}

function configuredKeyHint(binding: Parameters<typeof keyText>[0], fallbackKey: string, description: string): string {
	try {
		if (keyText(binding).trim()) return keyHint(binding, description);
	} catch { /* fall back below */ }
	return rawKeyHint(fallbackKey, description);
}

function expandHint(_theme: Theme, action: "expand" | "collapse" | "toggle" = "toggle"): string {
	return ` • ${configuredKeyHint("app.tools.expand", "ctrl+o", `to ${action}`)}`;
}

function deepExpandHint(): string {
	return ` • ${rawKeyHint("ctrl+shift+o", extraToolOutputExpanded ? "less detail" : "more detail")}`;
}

function toolOutputDetailHint(theme: Theme, expanded: boolean, hasMore = false): string {
	if (!expanded) return expandHint(theme, "toggle");
	const parts = [expandHint(theme, "collapse")];
	if (hasMore || extraToolOutputExpanded) parts.push(deepExpandHint());
	return parts.join("");
}

function clearStateKeys(state: Record<string, unknown> | undefined, ...keys: string[]): void {
	if (!state) return;
	for (const key of keys) {
		delete state[key];
	}
}

function clearToolRenderCache(value: unknown): void {
	if (!value || typeof value !== "object") return;
	delete (value as any)[TOOL_RENDER_CACHE];

}

function unrefTimer(timer: ReturnType<typeof setTimeout> | null | undefined): void {
	(timer as any)?.unref?.();
}

/**
 * Bumped whenever we mutate rendered content. The activity render is memoised per container
 * (see renderActivityTranscript); anything that changes what a row should say has to bump
 * this, or a repaint would reuse the previous lines.
 */
let _activityContentEpoch = 0;

function safeInvalidate(ctx: any): void {
	try {
		_activityContentEpoch++;
		if (typeof ctx?.invalidate === "function") ctx.invalidate();
	} catch {
		// Tool render contexts may outlive their row during reload/session switches.
	}
}

/** Do the container's children (and their render-relevant flags) match the cached render? */
function sameActivityChildren(
	children: any[],
	cached: any[],
): boolean {
	if (children.length !== cached.length) return false;
	for (let i = 0; i < children.length; i++) {
		const a = children[i];
		const b = cached[i];
		if (a !== b) return false;
		if (a?.isPartial !== b?.isPartial || a?.expanded !== b?.expanded) return false;
	}
	return true;
}

const ASSISTANT_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-assistant-message");
const ASSISTANT_RENDER_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-assistant-message-render");
const TOOL_EXECUTION_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-tool-execution");

// Rendered-output cache for assistant/custom message components.
// Keyed by (width, branch visual epoch, tool background mode). The epoch changes on
// theme / /cc-tools branch / /cc-theme rebinds; the mode is included because subagent
// (custom-message) framing follows `toolBackgroundMode` via frameToolLikeLines. This avoids
// re-running the per-line ANSI stripping (applyTerminalCopyZones, normalizeLeadingCheckGlyph,
// border boxing) on every scroll/expand re-render — the dominant CPU cost on long chats,
// scaling linearly with chat length.
// Correctness:
//  - AssistantMessageComponent rebuilds children only via updateContent(), which clears the cache.
//  - CustomMessageComponent rebuilds children only via rebuild(), which clears the cache.
// The returned arrays are only ever spread-copied by Container.render (never mutated in place),
// so sharing the cached array reference across renders is safe.
const MESSAGE_RENDER_CACHE = Symbol.for("pi-claude-style-tools:message-render-cache");

function messageRenderCacheHit(thisArg: any, width: number): string[] | null {
	const cache = thisArg?.[MESSAGE_RENDER_CACHE];
	if (
		cache
		&& cache.width === width
		&& cache.epoch === _toolBranchVisualEpoch
		&& cache.mode === toolBackgroundMode
		&& Array.isArray(cache.lines)
	) {
		return cache.lines;
	}
	return null;
}

function storeMessageRenderCache(thisArg: any, width: number, lines: string[]): string[] {
	if (thisArg && typeof thisArg === "object") {
		thisArg[MESSAGE_RENDER_CACHE] = {
			width,
			epoch: _toolBranchVisualEpoch,
			mode: toolBackgroundMode,
			lines,
		};
	}
	return lines;
}

function clearMessageRenderCache(thisArg: any): void {
	if (thisArg && typeof thisArg === "object") thisArg[MESSAGE_RENDER_CACHE] = undefined;
}
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const WORKED_DURATION_KEY = "_piClaudeStyleWorkedDurationMs";
const WORKED_START_KEY = "_piClaudeStyleWorkedStartMs";
const WORKED_SESSION_TOTAL_KEY = "_piClaudeStyleWorkedSessionTotalMs";
// Storage key string is frozen for resume compatibility: sessions written by
// older builds record the session prompt count under this name.
const WORKED_TURNS_KEY = "_piClaudeStyleWorkedTurns";
/** Status-line label. "Agent" keeps it distinct from pi's own turn terminology. */
const WORKED_DURATION_MARKER = "Agent took";
/** Pre-rename label; transcripts written by older builds may still carry it. */
const LEGACY_WORKED_DURATION_MARKER = "Turn took";
const WORKED_DURATION_MARKERS = [WORKED_DURATION_MARKER, LEGACY_WORKED_DURATION_MARKER];
const WORKED_DURATION_LINE_PATTERN = /^✻ (?:Agent|Turn) took [^\r\n]+$/;
const THINKING_DURATION_KEY = "_piClaudeStyleThinkingDurationMs";
/** Pinned text-rate estimate, used only when no wall clock exists for a live block. */
const THINKING_ESTIMATE_KEY = "_piClaudeStyleThinkingEstimateMs";
const THINKING_ACTIVE_KEY = "_piClaudeStyleThinkingActive";
const MIN_THINKING_SUMMARY_MS = 100;

let lastThinkingBlockDurationMs: number | undefined;
let thinkingBlockStartMs = 0;
/** True from thinking_start until thinking_end on the current assistant stream. */
let thinkingBlockInFlight = false;
// WORKED_LINE_FG is theme-derived (from "muted") when themeAdaptive is on.
let WORKED_LINE_FG = "\x1b[38;2;140;140;140m";
let currentAgentWorkStartMs: number | undefined;
let currentAssistantMessageStartMs: number | undefined;
// Session-wide accumulators for the "Agent took … (Total time … · N turns)" line.
// Total time is active agent work only: the sum of completed runs. It must never
// include time spent idle while the user reads or writes a prompt. Both values
// are re-seeded from persisted message metadata on resume/reload.
let sessionWorkedTotalMs = 0;
// Turns fired by the current agent run — pi's turn unit: one model response plus
// the tool calls it makes. Reset whenever a new run starts.
let currentRunTurnCount = 0;
/** Last known run turn count, used for history rows that carry no stamp. */
let lastRunTurnCount = 0;

function seedSessionTiming(messages: any[]): void {
	let workedTotalMs = 0;
	let runTurnCount = 0;
	let runHasAssistant = false;
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		if (message.role === "user") {
			runTurnCount = 0;
			runHasAssistant = false;
			continue;
		}
		if (message.role !== "assistant") continue;
		runTurnCount++;
		runHasAssistant = true;
		const stampedTurns = (message as any)[WORKED_TURNS_KEY];
		if (typeof stampedTurns === "number" && stampedTurns > 0) runTurnCount = stampedTurns;
		if (message.stopReason !== "stop") continue;
		const durationMs = (message as any)[WORKED_DURATION_KEY];
		if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) continue;
		workedTotalMs += durationMs;
		// Older builds stored wall-clock elapsed totals. Normalize loaded message
		// objects in memory so rerenders show cumulative work instead.
		(message as any)[WORKED_SESSION_TOTAL_KEY] = workedTotalMs;
		if (typeof stampedTurns === "number" && stampedTurns > 0) continue;
		// Transcripts written before turns were stamped: derive the run's turn
		// count from the assistant messages it produced.
		(message as any)[WORKED_TURNS_KEY] = runTurnCount;
	}
	sessionWorkedTotalMs = workedTotalMs;
	lastRunTurnCount = runHasAssistant ? runTurnCount : 0;
}

function sessionBranchMessages(ctx: any): any[] | undefined {
	try {
		const entries = ctx?.sessionManager?.getBranch?.();
		if (!Array.isArray(entries)) return undefined;
		return entries
			.filter((entry: any) => entry?.type === "message" && entry.message)
			.map((entry: any) => entry.message);
	} catch {
		return undefined;
	}
}

function formatWorkedDuration(ms: number): string {
	const safeMs = Math.max(0, Number.isFinite(ms) ? ms : 0);
	if (safeMs < 60_000) {
		return `${Math.max(0, Math.floor(safeMs / 1000))}s`;
	}
	let days = Math.floor(safeMs / 86_400_000);
	let hours = Math.floor((safeMs % 86_400_000) / 3_600_000);
	let minutes = Math.floor((safeMs % 3_600_000) / 60_000);
	let seconds = Math.round((safeMs % 60_000) / 1000);
	if (seconds === 60) {
		seconds = 0;
		minutes++;
	}
	if (minutes === 60) {
		minutes = 0;
		hours++;
	}
	if (hours === 24) {
		hours = 0;
		days++;
	}
	if (days > 0) return `${days}d ${hours}h ${minutes}m`;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	return `${minutes}m ${seconds}s`;
}

function formatThoughtDuration(ms: number): string {
	const safeMs = Math.max(0, Number.isFinite(ms) ? ms : 0);
	if (safeMs < 60_000) return `${Math.max(1, Math.round(safeMs / 1000))}s`;
	return formatWorkedDuration(safeMs);
}

/** Session-total duration: seconds are always shown; minutes and hours are
 *  added only once the session has actually lasted that long.
 *  e.g. 45s, 12m 30s, 1h 12m 30s. */
function formatSessionTotal(ms: number): string {
	const safeMs = Math.max(0, Number.isFinite(ms) ? ms : 0);
	const totalSeconds = Math.floor(safeMs / 1000);
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (totalMinutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function pluralizeTurns(n: number): string {
	return `${n} turn${n === 1 ? "" : "s"}`;
}

function thinkingSummaryStyledText(body: string): string {
	// Preserve the visible thinking text column while omitting ∴ when collapsed.
	return `   ${WORKED_LINE_FG}${body}${RESET}`;
}

function thinkingActiveSummaryText(): string {
	return thinkingSummaryStyledText("Thinking…");
}

function thoughtDurationSummaryText(ms: number): string {
	return thinkingSummaryStyledText(`Thought for ${formatThoughtDuration(ms)}`);
}

/** Single-line hidden thinking row — no Text paddingX or thinking symbol. */
class HiddenThinkingSummary {
	private summaryText: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(summaryText: string) {
		this.summaryText = summaryText;
	}

	setSummary(summaryText: string): void {
		this.summaryText = summaryText;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		if (safeWidth <= 0) {
			this.cachedWidth = width;
			this.cachedLines = [""];
			return this.cachedLines;
		}
		const line = padRenderedLineToWidth(this.summaryText, safeWidth);
		this.cachedWidth = width;
		this.cachedLines = [line];
		return this.cachedLines;
	}
}

/** Wall-clock elapsed since this assistant message started streaming, or null when
 *  the message is not an in-flight assistant message. */
function liveMessageElapsedMs(message: any): number | null {
	if (!message || message.role !== "assistant") return null;
	if (isAssistantThinkingComplete(undefined, message)) return null;
	const stamped = (message as any)?.[WORKED_START_KEY];
	const started = typeof stamped === "number" && stamped > 0 ? stamped : currentAssistantMessageStartMs;
	if (typeof started !== "number" || started <= 0) return null;
	return Math.max(0, Date.now() - started);
}

function getMessageThinkingDurationMs(message: any): number {
	const stored = (message as any)?.[THINKING_DURATION_KEY];
	if (typeof stored === "number" && stored > 0) return stored;
	if (typeof lastThinkingBlockDurationMs === "number" && lastThinkingBlockDurationMs > 0) {
		return lastThinkingBlockDurationMs;
	}
	if (typeof (message as any)?.[WORKED_DURATION_KEY] === "number" && (message as any)[WORKED_DURATION_KEY] > 0) {
		return (message as any)[WORKED_DURATION_KEY];
	}
	// A block that is still streaming without any timing event (some providers send
	// thinking deltas but never a start/end marker) has no measured duration. Fall
	// back to the message's own wall clock: the text-length estimate below assumes
	// 150 chars/s of thinking, so a model streaming thousands of chars per second
	// reported tens of seconds per second and the number climbed absurdly.
	const liveElapsed = liveMessageElapsedMs(message);
	if (liveElapsed !== null) return liveElapsed;
	let totalChars = 0;
	if (Array.isArray(message?.content)) {
		for (const block of message.content) {
			if (block?.type === "thinking" && typeof block.thinking === "string") {
				totalChars += block.thinking.length;
			}
		}
	}
	// Last resort, with no clock to measure from: a historical message's thinking text
	// yields a fixed estimate, but an in-flight one would keep re-estimating against a
	// growing stream. Pin the first reading so it cannot climb with it.
	const estimate = Math.max(1000, Math.round((totalChars / 150) * 1000));
	if (isAssistantThinkingComplete(undefined, message)) return estimate;
	const pinned = (message as any)?.[THINKING_ESTIMATE_KEY];
	if (typeof pinned === "number" && pinned > 0) return pinned;
	if (message && typeof message === "object") (message as any)[THINKING_ESTIMATE_KEY] = estimate;
	return estimate;
}

function assistantMessageThinkingComplete(this: any, message: any): boolean {
	return isAssistantThinkingComplete(this, message);
}

function hiddenThinkingSummaryForMessage(message: any, comp?: any): string {
	if (message && !isAssistantThinkingComplete(comp, message) && isLiveThinkingMessage(comp, message)) {
		return thinkingActiveSummaryText();
	}
	const durationMs = getMessageThinkingDurationMs(message);
	if (message && typeof message === "object") {
		(message as any)[THINKING_DURATION_KEY] = durationMs;
	}
	return thoughtDurationSummaryText(durationMs);
}

function isHiddenThinkingPlaceholderText(child: unknown): child is InstanceType<typeof Text> {
	if (!isTextComponent(child)) return false;
	const plain = stripAnsi(String((child as any).text ?? "")).trim();
	if (/^[✻∴]\s*Thinking/i.test(plain)) return true;
	if (/^[✻∴]\s*Thought for/i.test(plain)) return true;
	if (/^Thought for\b/i.test(plain)) return true;
	if (/^Thinking\.\.\.$/i.test(plain)) return true;
	if (/^Thinking…$/i.test(plain)) return true;
	return /^Thinking:?\s*$/i.test(plain);
}

function messageHasThinkingContent(message: any): boolean {
	return Array.isArray(message?.content)
		&& message.content.some((block: any) => block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim());
}

function workedDurationText(ms: number, sessionTotalMs?: number, turns?: number): string {
	let text = `${WORKED_LINE_FG}✻ ${WORKED_DURATION_MARKER} ${formatWorkedDuration(ms)}`;
	if (typeof sessionTotalMs === "number" && typeof turns === "number" && turns > 0) {
		text += ` (Total time ${formatSessionTotal(sessionTotalMs)} · ${pluralizeTurns(turns)})`;
	}
	return `${text}${RESET}`;
}

function mentionsWorkedDuration(text: string): boolean {
	return WORKED_DURATION_MARKERS.some((marker) => text.includes(marker));
}

function isWorkedDurationLine(line: string): boolean {
	const plain = stripAnsi(line).trim();
	return mentionsWorkedDuration(plain) && WORKED_DURATION_LINE_PATTERN.test(plain);
}

function stripWorkedDurationLine(text: string): string {
	if (!mentionsWorkedDuration(text)) return text;
	return text
		.split(/\r?\n/)
		.filter((line) => !isWorkedDurationLine(line))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n");
}

function hasWorkedDurationLine(message: any): boolean {
	if (!Array.isArray(message?.content)) return false;
	return message.content.some((block: any) => {
		if (block?.type !== "text" || typeof block.text !== "string" || !mentionsWorkedDuration(block.text)) return false;
		return block.text.split(/\r?\n/).some(isWorkedDurationLine);
	});
}

type MarkdownThemeLike = ConstructorParameters<typeof Markdown>[3];

type ParagraphSegment =
	| { kind: "markdown"; md: InstanceType<typeof Markdown> }
	| { kind: "math"; raw: string };

interface MathDelimiter {
	open: string;
	close: string;
}

const DISPLAY_MATH_DELIMITERS: MathDelimiter[] = [
	{ open: "\\[", close: "\\]" },
	{ open: "$$", close: "$$" },
	{ open: "\\begin{equation}", close: "\\end{equation}" },
	{ open: "\\begin{equation*}", close: "\\end{equation*}" },
	{ open: "\\begin{align}", close: "\\end{align}" },
	{ open: "\\begin{align*}", close: "\\end{align*}" },
	{ open: "\\begin{aligned}", close: "\\end{aligned}" },
];

const MATH_COMMANDS: Record<string, string> = {
	alpha: "α", beta: "β", gamma: "γ", Gamma: "Γ", delta: "δ", Delta: "Δ",
	epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", Theta: "Θ",
	vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", Lambda: "Λ", mu: "μ",
	nu: "ν", xi: "ξ", Xi: "Ξ", pi: "π", Pi: "Π", rho: "ρ", varrho: "ϱ",
	sigma: "σ", Sigma: "Σ", tau: "τ", upsilon: "υ", Upsilon: "Υ", phi: "φ",
	varphi: "φ", Phi: "Φ", chi: "χ", psi: "ψ", Psi: "Ψ", omega: "ω", Omega: "Ω",
	pm: "±", mp: "∓", times: "×", cdot: "·", div: "÷", ast: "*", le: "≤", leq: "≤",
	ge: "≥", geq: "≥", neq: "≠", ne: "≠", approx: "≈", sim: "∼", propto: "∝",
	infty: "∞", partial: "∂", nabla: "∇", sum: "Σ", prod: "Π", int: "∫", sqrt: "√",
	to: "→", rightarrow: "→", leftarrow: "←", leftrightarrow: "↔", in: "∈", notin: "∉",
	cup: "∪", cap: "∩", subset: "⊂", subseteq: "⊆", superset: "⊃", superseteq: "⊇",
	wedge: "∧", vee: "∨", forall: "∀", exists: "∃", emptyset: "∅", degree: "°",
};

const COPY_SAFE_MARKDOWN_LINKS_FLAG = Symbol.for("pi-claude-style-tools:copy-safe-markdown-links");

function copySafeMarkdownTheme(theme: MarkdownThemeLike): MarkdownThemeLike {
	return {
		...theme,
		link: (text: string) => stripAnsi(text),
		linkUrl: (text: string) => stripAnsi(text),
	};
}

function makeMarkdownLinksCopySafe(markdown: InstanceType<typeof Markdown>): void {
	const markdownAny = markdown as any;
	if (markdownAny[COPY_SAFE_MARKDOWN_LINKS_FLAG] || !markdownAny.theme) return;
	markdownAny.theme = copySafeMarkdownTheme(markdownAny.theme);
	markdownAny[COPY_SAFE_MARKDOWN_LINKS_FLAG] = true;
	markdown.invalidate?.();
}

function codeSpan(text: string): string {
	const safe = text.replace(/`/g, "′");
	return `\`${safe}\``;
}

function looksLikeInlineMath(text: string): boolean {
	return /\\[A-Za-z]+|[_^=<>+*/-]/.test(text) && /[A-Za-z0-9}]/.test(text);
}

function hasInlineMathMarkers(text: string): boolean {
	return text.includes("\\(") || text.includes("$");
}

// Magic Context prefixes live assistant text with §N§ while the response is
// streaming and removes that metadata on message_end. Keep the transient tag
// out of the display without mutating the message used by context management.
const MAGIC_CONTEXT_TAG_LINE_PREFIX = /(^|\r?\n)[ \t]*(?:§\d+§[ \t]*)+/g;

function stripTransientMagicContextTags(text: string): string {
	return text.replace(MAGIC_CONTEXT_TAG_LINE_PREFIX, "$1");
}

// Tool results can carry transient Magic Context tags too (live-prefixed output
// chunks). Renderers must see sanitized text WITHOUT mutating this.result — the
// result object is the stored message used by context management. Clone blocks
// only when a tag is actually present so the common path stays zero-cost.
function sanitizeToolResultForDisplay(result: any): any {
	if (!result || !Array.isArray(result.content)) return result;
	let changed = false;
	const content = result.content.map((block: any) => {
		if (block && typeof block.text === "string") {
			const stripped = stripTransientMagicContextTags(block.text);
			if (stripped !== block.text) {
				changed = true;
				return { ...block, text: stripped };
			}
		}
		return block;
	});
	return changed ? { ...result, content } : result;
}

// Last-resort display scrubber at the terminal writer choke point. Every
// rendered frame — every component, overlay, preview, and search hit — exits
// through ProcessTerminal.write, so stripping complete §N§ tokens there covers
// any surface the targeted strips above can't reach, including mid-sentence
// tag references replayed from old tool output on resume. Display only:
// storage, LLM context, copy/paste sources, and ANSI sequences are untouched
// (tags are plain characters; escape sequences never contain them).
const MAGIC_CONTEXT_TAG_TOKEN = /§\d+§/g;
const TERMINAL_SCRUB_PATCH_FLAG = Symbol.for("pi-claude-style-tools:terminal-write-tag-scrub");

function patchTerminalWriteTagScrubber(): void {
	const proto = (ProcessTerminal as any)?.prototype;
	if (!proto || proto[TERMINAL_SCRUB_PATCH_FLAG]) return;
	const originalWrite = proto.write;
	if (typeof originalWrite !== "function") return;
	proto.write = function patchedTerminalWrite(this: any, data: any, ...rest: any[]) {
		if (typeof data === "string" && data.includes("§")) {
			data = data.replace(MAGIC_CONTEXT_TAG_TOKEN, "");
		}
		return originalWrite.call(this, data, ...rest);
	};
	proto[TERMINAL_SCRUB_PATCH_FLAG] = true;
}

function replaceInlineMath(text: string): string {
	if (!hasInlineMathMarkers(text)) return text;
	const withParens = text.replace(/\\\(([\s\S]*?)\\\)/g, (_match, body: string) => {
		return codeSpan(formatMathForDisplay(body, false));
	});
	return withParens.replace(/(^|[^\\])\$([^\n$]{1,200})\$/g, (match, prefix: string, body: string) => {
		if (!looksLikeInlineMath(body)) return match;
		return `${prefix}${codeSpan(formatMathForDisplay(body, false))}`;
	});
}

interface MathBlock {
	index: number;
	contentStart: number;
	contentEnd: number;
	endIndex: number;
}

function findNextDelimitedMathBlock(text: string, start: number): MathBlock | undefined {
	let best: MathBlock | undefined;
	for (const delimiter of DISPLAY_MATH_DELIMITERS) {
		const index = text.indexOf(delimiter.open, start);
		if (index === -1) continue;
		const contentStart = index + delimiter.open.length;
		const contentEnd = text.indexOf(delimiter.close, contentStart);
		if (contentEnd === -1) continue;
		if (!best || index < best.index) {
			best = { index, contentStart, contentEnd, endIndex: contentEnd + delimiter.close.length };
		}
	}
	return best;
}

function looksLikeDisplayMath(text: string): boolean {
	return /\\[A-Za-z]+|[_^=<>+*/|]/.test(text) && /[A-Za-z0-9}]/.test(text);
}

function findNextLooseBracketMathBlock(text: string, start: number): MathBlock | undefined {
	const openRe = /(^|\r?\n)[ \t]*\[[ \t]*(?:\r?\n)/g;
	openRe.lastIndex = start;
	let openMatch: RegExpExecArray | null;
	while ((openMatch = openRe.exec(text))) {
		const index = openMatch.index + openMatch[1].length;
		const contentStart = openMatch.index + openMatch[0].length;
		const closeRe = /(^|\r?\n)[ \t]*\][ \t]*(?=\r?\n|$)/g;
		closeRe.lastIndex = contentStart;
		const closeMatch = closeRe.exec(text);
		if (!closeMatch) return undefined;
		const contentEnd = closeMatch.index + closeMatch[1].length;
		const raw = text.slice(contentStart, contentEnd).trim();
		if (looksLikeDisplayMath(raw)) {
			return { index, contentStart, contentEnd, endIndex: closeMatch.index + closeMatch[0].length };
		}
		openRe.lastIndex = contentStart;
	}
	return undefined;
}

function hasDisplayMathMarkers(text: string): boolean {
	return text.includes("\\[") || text.includes("$$") || text.includes("\\begin{") || /(^|\n)[ \t]*\[[ \t]*(?:\r?\n)/.test(text);
}

function shouldScanLooseBracketMath(text: string): boolean {
	return text.length < 20_000 && /(^|\n)[ \t]*\[[ \t]*(?:\r?\n)/.test(text);
}

function findNextDisplayMathBlock(text: string, start: number, scanLoose: boolean): MathBlock | undefined {
	const delimited = findNextDelimitedMathBlock(text, start);
	const loose = scanLoose ? findNextLooseBracketMathBlock(text, start) : undefined;
	if (!delimited) return loose;
	if (!loose) return delimited;
	return loose.index < delimited.index ? loose : delimited;
}

function looksLikeMarkdownDocument(text: string): boolean {
	if (/\r?\n\s*\r?\n/.test(text)) return true;
	if (/^#{1,6}\s/m.test(text) || /```/.test(text)) return true;
	if (/^\s*[-*+]\s/m.test(text) || /^\s*\d+\.\s/m.test(text)) return true;
	if (/\|[^|\n]+\|/.test(text)) return true;
	if (/https?:\/\//.test(text)) return true;
	return false;
}

function shouldFormatStandaloneMath(text: string): boolean {
	const plain = text.trim();
	if (!plain || !plain.includes("\\")) return false;
	// Whole assistant paragraphs must stay markdown; misclassifying them collapses newlines.
	if (looksLikeMarkdownDocument(text)) return false;
	if (plain.length > 600 || plain.split(/\r?\n/).length > 3) return false;
	if (/\\(?:frac|dfrac|tfrac|sqrt|left|right|begin|end|partial|boldsymbol|bm|mathrm|mathbf|mathit|mathsf|mathtt|mathbb|sigma|epsilon|delta|gamma|Gamma|Delta|theta|Theta|pi|Pi|rho|varrho|tau|phi|varphi|Psi|psi|omega|Omega|alpha|beta|mu|nu|xi|chi|sum|prod|int|to|rightarrow|leftarrow|leftrightarrow|infty)/.test(plain)) {
		return true;
	}
	// Paths like \opencode and prose with "=" are not math; require tight expression shape.
	if (!/[_^]/.test(plain) || !/\\[A-Za-z]+/.test(plain)) return false;
	return !/[.!?]\s/.test(plain) && plain.length <= 240;
}

function appendMarkdownSegment(segments: ParagraphSegment[], text: string, theme: MarkdownThemeLike): void {
	if (!text.trim()) return;
	const normalized = shouldFormatStandaloneMath(text) ? formatMathForDisplay(text, false) : replaceInlineMath(text);
	segments.push({ kind: "markdown", md: new Markdown(normalized, 0, 0, theme) });
}

function buildParagraphSegments(text: string, theme: MarkdownThemeLike): ParagraphSegment[] {
	const segments: ParagraphSegment[] = [];
	if (!hasDisplayMathMarkers(text)) {
		appendMarkdownSegment(segments, text, theme);
		return segments;
	}
	const scanLoose = shouldScanLooseBracketMath(text);
	let cursor = 0;
	while (cursor < text.length) {
		const next = findNextDisplayMathBlock(text, cursor, scanLoose);
		if (!next) break;
		appendMarkdownSegment(segments, text.slice(cursor, next.index), theme);
		const raw = text.slice(next.contentStart, next.contentEnd).trim();
		if (raw) segments.push({ kind: "math", raw });
		cursor = next.endIndex;
	}
	appendMarkdownSegment(segments, text.slice(cursor), theme);
	return segments;
}

function replaceSimpleCommandGroups(text: string): string {
	return text
		.replace(/\\(?:text|mathrm|operatorname|mathbf|boldsymbol|bm|mathit|mathsf|mathtt)\{([^{}]*)\}/g, "$1")
		.replace(/\\(?:boldsymbol|bm)\s+([A-Za-z])/g, "$1")
		.replace(/\\mathbb\{R\}/g, "ℝ")
		.replace(/\\mathbb\{N\}/g, "ℕ")
		.replace(/\\mathbb\{Z\}/g, "ℤ")
		.replace(/\\mathbb\{Q\}/g, "ℚ")
		.replace(/\\mathbb\{C\}/g, "ℂ");
}

function readLatexGroup(text: string, start: number): { content: string; end: number } | undefined {
	let open = start;
	while (open < text.length && /\s/.test(text[open])) open++;
	if (text[open] !== "{") return undefined;
	let depth = 1;
	for (let index = open + 1; index < text.length; index++) {
		const char = text[index];
		if (char === "{") depth++;
		else if (char === "}") {
			depth--;
			if (depth === 0) return { content: text.slice(open + 1, index), end: index + 1 };
		}
	}
	return undefined;
}

function replaceFractions(text: string): string {
	let output = "";
	let index = 0;
	while (index < text.length) {
		const command = ["\\frac", "\\dfrac", "\\tfrac"].find((candidate) => text.startsWith(candidate, index));
		if (!command) {
			output += text[index];
			index++;
			continue;
		}
		const numerator = readLatexGroup(text, index + command.length);
		const denominator = numerator ? readLatexGroup(text, numerator.end) : undefined;
		if (!numerator || !denominator) {
			output += text[index];
			index++;
			continue;
		}
		output += `(${replaceFractions(numerator.content)})/(${replaceFractions(denominator.content)})`;
		index = denominator.end;
	}
	return output;
}

function replaceMathCommands(text: string): string {
	return text.replace(/\\([A-Za-z]+)/g, (match, name: string) => MATH_COMMANDS[name] ?? match);
}

function formatMathForDisplay(raw: string, multiline = true): string {
	let text = raw.replace(/\\\\/g, "\n");
	text = text.replace(/\\(?:begin|end)\{[^{}]+\}/g, "").replace(/&/g, "");
	text = replaceSimpleCommandGroups(text);
	text = replaceFractions(text);
	text = text.replace(/\\sqrt\s*\{([^{}]+)\}/g, "√($1)");
	text = replaceMathCommands(text);
	text = text.replace(/\\(?:left|right|big|Big|bigg|Bigg)/g, "");
	text = text.replace(/_\{([^{}]+)\}/g, "_$1").replace(/\^\{([^{}]+)\}/g, "^$1");
	text = text.replace(/[{}]/g, "").replace(/\\[,;!]/g, " ").replace(/\\ /g, " ");
	text = text.replace(/[ \t]+/g, " ").replace(/\s*([=+\-×·÷<>≤≥≈≠|])\s*/g, " $1 ");
	const lines = text.split(/\r?\n/).map((line) => line.replace(/[ \t]{2,}/g, " ").trim()).filter(Boolean);
	return multiline ? lines.join("\n") : lines.join(" ");
}

function renderMathBlock(raw: string, width: number, theme: MarkdownThemeLike): string[] {
	const safeWidth = Math.max(12, width);
	const formatted = formatMathForDisplay(raw, true) || raw;
	return formatted
		.split("\n")
		.flatMap((line) => wrapTextWithAnsi(theme.bold(line), safeWidth));
}

/**
 * Renders assistant prose that needs more than Pi's Markdown renderer: display math
 * blocks (`\[…\]`, `$$…$$`) and task-status transcripts that need glyph cleanup.
 * Plain prose keeps Pi's own Markdown child so it renders flush left, exactly like stock pi.
 */
class FlushParagraph {
	private segments: ParagraphSegment[];
	private markdownTheme: MarkdownThemeLike;
	private pad: number;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(text: string, markdownTheme: MarkdownThemeLike, pad = 1) {
		this.markdownTheme = copySafeMarkdownTheme(markdownTheme);
		this.pad = Number.isFinite(pad) ? Math.max(0, Math.floor(pad)) : 1;
		this.segments = buildParagraphSegments(stripTransientMagicContextTags(text), this.markdownTheme);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		for (const segment of this.segments) {
			if (segment.kind === "markdown") segment.md.invalidate();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		if (safeWidth <= 0) {
			this.cachedWidth = width;
			this.cachedLines = [""];
			return this.cachedLines;
		}
		// Match Pi's stock assistant padding (Markdown children get `outputPad`, 1 by
		// default) so math/status prose lines up with every other prose block.
		const pad = Math.min(this.pad, safeWidth);
		const contentWidth = safeWidth - pad;
		if (contentWidth <= 0) {
			this.cachedWidth = width;
			this.cachedLines = [" ".repeat(safeWidth)];
			return this.cachedLines;
		}
		const gutter = " ".repeat(pad);
		const lines = this.segments.flatMap((segment) => {
			return segment.kind === "math"
				? renderMathBlock(segment.raw, contentWidth, this.markdownTheme)
				: sanitizeRenderedTextBlockLines(segment.md.render(contentWidth), contentWidth);
		});
		const looksLikeTaskStatus = lines.some((line) => /\b(?:transcript:|No output\.|Wrapped up)/.test(stripAnsi(line)));
		const displayLines = looksLikeTaskStatus ? lines.map(normalizeLeadingCheckGlyph) : lines;
		const rendered = displayLines.map((line) => {
			const padded = line ? `${gutter}${line}` : line;
			const gap = safeWidth - visibleWidth(padded);
			return gap > 0 ? padded + " ".repeat(gap) : gap < 0 ? truncateToWidth(padded, safeWidth, "", false) : padded;
		});
		this.cachedWidth = width;
		this.cachedLines = rendered;
		return rendered;
	}
}

/** True when prose needs {@link FlushParagraph} instead of Pi's stock Markdown child. */
function needsFlushParagraph(text: string): boolean {
	return hasDisplayMathMarkers(text) || /\b(?:transcript:|No output\.|Wrapped up)/.test(text);
}

function replaceHiddenThinkingPlaceholders(container: { children?: any[]; child?: any }, message: any): void {
	const summary = hiddenThinkingSummaryForMessage(message);
	const replace = (child: any): any => {
		if (child instanceof HiddenThinkingSummary) {
			child.setSummary(summary);
			return child;
		}
		if (isHiddenThinkingPlaceholderText(child)) return new HiddenThinkingSummary(summary);
		// Preserve MouseRegion identity and its click handler on newer Pi versions.
		if (child?.child) child.child = replace(child.child);
		return child;
	};
	if (container.children) container.children = container.children.map(replace);
	if (container.child) container.child = replace(container.child);
}

class ThinkingParagraph {
	private text: string;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private chromeEpoch = -1;
	private cachedNoGutter?: boolean;

	constructor(
		text: string,
		_markdownTheme: ConstructorParameters<typeof Markdown>[3],
		_defaultTextStyle?: ConstructorParameters<typeof Markdown>[4],
	) {
		this.text = stripTransientMagicContextTags(text);
	}

	private thinkingMarkdown(): InstanceType<typeof Markdown> {
		const DIM_FG = WORKED_LINE_FG;
		const wrap = (s: string) => `${DIM_FG}${s}`;
		const wrapPlain = (s: string) => wrap(stripAnsi(s));
		const plainTheme: ConstructorParameters<typeof Markdown>[3] = {
			heading: wrap,
			link: wrapPlain,
			linkUrl: wrapPlain,
			code: wrap,
			codeBlock: wrap,
			codeBlockBorder: wrap,
			quote: wrap,
			quoteBorder: wrap,
			hr: wrap,
			listBullet: (marker: string) => wrap(marker),
			bold: wrap,
			italic: wrap,
			strikethrough: wrap,
			underline: wrap,
			highlightCode: (code: string, _lang?: string) => code.split("\n").map((line) => `${DIM_FG}${line}`),
		};
		const plainStyle: ConstructorParameters<typeof Markdown>[4] = {
			italic: false,
			color: (s: string) => `${DIM_FG}${s}`,
		};
		return new Markdown(this.text, 0, 0, plainTheme, plainStyle);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.chromeEpoch = -1;
		this.cachedNoGutter = undefined;
	}

	render(width: number, options?: { noGutter?: boolean }): string[] {
		const noGutter = options?.noGutter === true;
		if (
			this.cachedLines
			&& this.cachedWidth === width
			&& this.chromeEpoch === _toolBranchVisualEpoch
			&& this.cachedNoGutter === noGutter
		) {
			return this.cachedLines;
		}
		const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		if (safeWidth <= 0) {
			this.cachedWidth = width;
			this.cachedLines = [""];
			this.chromeEpoch = _toolBranchVisualEpoch;
			return this.cachedLines;
		}
		const md = this.thinkingMarkdown();
		// " ∴ " = 1 margin + symbol + space = 3 visible chars
		const PREFIX_W = 3;
		const prefix = `${WORKED_LINE_FG}∴${RESET}`;
		if (safeWidth <= PREFIX_W) {
			this.cachedWidth = width;
			this.cachedLines = [clampLineWidth(` ${prefix} `, safeWidth)];
			return this.cachedLines;
		}
		const bodyWidth = noGutter ? safeWidth : safeWidth - PREFIX_W;
		const lines = sanitizeRenderedTextBlockLines(md.render(bodyWidth), bodyWidth);
		if (noGutter) {
			this.cachedWidth = width;
			this.cachedNoGutter = true;
			this.cachedLines = lines.map((line) => clampLineWidth(line, safeWidth));
			this.chromeEpoch = _toolBranchVisualEpoch;
			return this.cachedLines;
		}
		let symbolPlaced = false;
		const rendered = lines.map((line: string) => {
			if (!symbolPlaced && stripAnsi(line).trim()) {
				symbolPlaced = true;
				return ` ${prefix} ${line}`;
			}
			return `   ${line}`;
		}).map((line) => clampLineWidth(line, safeWidth));
		this.cachedWidth = width;
		this.cachedLines = rendered;
		this.chromeEpoch = _toolBranchVisualEpoch;
		return rendered;
	}
}

function trimRenderedBlankLines(lines: string[]): string[] {
	let start = 0;
	while (start < lines.length && isBlankLine(lines[start])) start++;
	let end = lines.length - 1;
	while (end >= start && isBlankLine(lines[end])) end--;
	return start <= end ? lines.slice(start, end + 1) : [];
}

function isSubagentNotificationMessage(message: unknown): boolean {
	const candidate = message as Record<string, unknown> | undefined;
	return candidate?.customType === "subagent-notification";
}

function isSubagentHeaderLine(line: string): boolean {
	return /^[✓✔✗■●]\s+/.test(stripAnsi(line).trimStart());
}

function isSubagentDetailLine(line: string): boolean {
	const plain = stripAnsi(line).trimStart();
	return plain.startsWith("⎿")
		|| plain.startsWith("transcript:")
		|| plain === "No output."
		|| /^(?:Done|Wrapped up|Stopped|Error:|Aborted)\b/.test(plain);
}

function cleanSubagentDetailLine(line: string): string {
	const markerIndex = line.indexOf("⎿");
	if (markerIndex !== -1) {
		const prefixAnsi = (line.slice(0, markerIndex).match(ANSI_RE) ?? []).join("");
		return `${prefixAnsi}${line.slice(markerIndex + 1).replace(/^\s+/, "")}`;
	}
	return line
		.replace(/^((?:\x1b\[[0-9;]*m)*)\s{2}/, "$1")
		.replace(/^\s{2}/, "");
}

function formatSubagentNotificationGroup(lines: string[]): string[] {
	if (lines.length === 0) return [];
	const header = normalizeLeadingCheckGlyph(lines[0]);
	const rest = lines.slice(1);
	const detailStart = rest.findIndex(isSubagentDetailLine);
	if (detailStart === -1) {
		return [header, ...rest];
	}

	const metadata = rest.slice(0, detailStart);
	const detailLines = rest.slice(detailStart).map(cleanSubagentDetailLine).filter((line) => stripAnsi(line).trim().length > 0);
	const formattedDetails = withFinalBranchBlock(detailLines.join("\n"), undefined as any).split("\n").filter((line) => line.length > 0);
	return [header, ...metadata, ...formattedDetails];
}

function splitSubagentNotificationGroups(lines: string[]): string[][] {
	const groups: string[][] = [];
	let current: string[] = [];
	for (const line of lines) {
		if (isSubagentHeaderLine(line) && current.length > 0) {
			groups.push(current);
			current = [line];
		} else {
			current.push(line);
		}
	}
	if (current.length > 0) groups.push(current);
	return groups;
}

function frameToolLikeLines(lines: string[], width: number): string[] {
	syncToolBackgroundMode();
	const safeWidth = Math.max(1, width);
	const core = trimRenderedBlankLines(lines).map((line) => clampLineWidth(line, safeWidth));
	if (core.length === 0 || toolBackgroundMode === "default") return core;
	const spacerLine = " ".repeat(safeWidth);
	return [spacerLine, ...core];
}

function formatSubagentNotification(lines: string[], width: number): string[] {
	const core = trimRenderedBlankLines(lines).map(normalizeLeadingCheckGlyph);
	if (core.length === 0) return lines;
	const formatted = splitSubagentNotificationGroups(core).flatMap((group, index) => {
		const groupLines = formatSubagentNotificationGroup(group);
		return index === 0 ? groupLines : ["", ...groupLines];
	});
	const indented = formatted.map((line) => (line ? ` ${line}` : line));
	return frameToolLikeLines(indented, width);
}

function patchCustomMessageRender(): void {
	const proto = CustomMessageComponent.prototype as any;
	if (proto[CUSTOM_MESSAGE_PATCH_FLAG]) return;
	const originalRender = proto.render;
	if (typeof originalRender !== "function") return;
	proto.render = function patchedCustomMessageRender(width: number) {
		// Subagent framing follows `toolBackgroundMode` (via frameToolLikeLines), which
		// can change via /cc-tools or by editing settings.json. Re-sync before the
		// cache check so the mode key reflects the current setting on warm renders too.
		syncToolBackgroundMode();
		const cached = messageRenderCacheHit(this, width);
		if (cached) return cached;
		visitMarkdownDescendants(this, (child) => {
			const markdownAny = child as any;
			if (typeof markdownAny.text === "string") {
				const stripped = stripTransientMagicContextTags(markdownAny.text);
				if (stripped !== markdownAny.text) {
					markdownAny.text = stripped;
					child.invalidate?.();
				}
			}
		});
		const lines = originalRender.call(this, width);
		if (!Array.isArray(lines)) return lines;
		const result = isSubagentNotificationMessage(this?.message)
			? formatSubagentNotification(lines, width)
			: lines.map(normalizeLeadingCheckGlyph);
		return storeMessageRenderCache(this, width, result);
	};
	// CustomMessageComponent rebuilds its children via rebuild() (called from
	// invalidate() and setExpanded()); drop the cached render so the next render
	// reflects the rebuilt content.
	const originalRebuild = proto.rebuild;
	if (typeof originalRebuild === "function") {
		proto.rebuild = function patchedCustomMessageRebuild(...args: any[]) {
			clearMessageRenderCache(this);
			return originalRebuild.apply(this, args);
		};
	}
	proto[CUSTOM_MESSAGE_PATCH_FLAG] = true;
}

function stripOsc133Zones(line: string): string {
	return line
		.replace(OSC133_ZONE_START, "")
		.replace(OSC133_ZONE_END, "")
		.replace(OSC133_ZONE_FINAL, "");
}

function stripBackgroundAnsi(text: string): string {
	return text.replace(/\x1b\[([0-9;]*)m/g, (match, paramsText: string) => {
		const params = paramsText === "" ? ["0"] : paramsText.split(";");
		const kept: string[] = [];
		for (let i = 0; i < params.length; i++) {
			const code = Number(params[i] || "0");
			if (code === 48) {
				const mode = Number(params[i + 1] || "0");
				i += mode === 2 ? 4 : mode === 5 ? 2 : 0;
				continue;
			}
			if (code === 49 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107)) continue;
			kept.push(params[i]);
		}
		return kept.length === 0 ? "" : `\x1b[${kept.join(";")}m`;
	});
}

function visitMarkdownDescendants(root: unknown, visit: (md: InstanceType<typeof Markdown>) => void): void {
	if (!root || typeof root !== "object") return;
	const node = root as { children?: unknown[] };
	for (const child of node.children ?? []) {
		if (isMarkdownComponent(child)) visit(child);
		else visitMarkdownDescendants(child, visit);
	}
}

function patchAssistantMessages(): void {
	const proto = AssistantMessageComponent.prototype as any;
	if (proto[ASSISTANT_PATCH_FLAG]) return;
	const originalRender = proto.render;
	if (typeof originalRender === "function" && !proto[ASSISTANT_RENDER_PATCH_FLAG]) {
		proto.render = function patchedAssistantMessageRender(width: number) {
			const cached = messageRenderCacheHit(this, width);
			if (cached) return cached;
			visitMarkdownDescendants(this, (child) => {
				const markdownAny = child as any;
				if (typeof markdownAny.text === "string") {
					const stripped = stripTransientMagicContextTags(markdownAny.text);
					if (stripped !== markdownAny.text) {
						markdownAny.text = stripped;
						child.invalidate?.();
					}
				}
			});
			const lines = originalRender.call(this, width);
			if (!Array.isArray(lines) || lines.length === 0) return lines;
			if ((this as any).hasToolCalls) {
				// Tool-call messages skip copy-zone processing, but still benefit from
				// caching the rendered output to avoid re-rendering stable children.
				return storeMessageRenderCache(this, width, lines);
			}
			return storeMessageRenderCache(this, width, applyTerminalCopyZones(lines));
		};
		proto[ASSISTANT_RENDER_PATCH_FLAG] = true;
	}
	const originalSetHideThinkingBlock = proto.setHideThinkingBlock;
	if (typeof originalSetHideThinkingBlock === "function") {
		proto.setHideThinkingBlock = function (hide: boolean) {
			this[THINKING_EXPANDED_KEY] = !hide;
			return originalSetHideThinkingBlock.call(this, hide);
		};
	}
	const originalUpdateContent = proto.updateContent;
	proto.updateContent = function patchedUpdateContent(message: any, isStreaming?: boolean) {
		// Content changed (also reached via invalidate() → updateContent): drop the
		// cached rendered output so the next render rebuilds with the new children.
		clearMessageRenderCache(this);
		if (!(this as any)[WORKED_START_KEY]) {
			(this as any)[WORKED_START_KEY] = Date.now();
		}
		if (!message || !Array.isArray(message.content)) {
			return originalUpdateContent.call(this, message, isStreaming);
		}
		// Thinking display:
		// Pi's `hideThinkingBlock` is the single source of truth (Ctrl+T / settings.json).
		// - `false` (thinking visible): `thinkingMode: "live"` streams the active thought
		//   and collapses finished ones to `Thought for Xs`; `"full"` keeps them expanded.
		// - `true` (thinking hidden): nothing streams — every run stays a one-line
		//   `Thinking… Xs` / `Thought for Xs` summary until the user expands it.
		const thinkingCollapsed = !!(this as any).hideThinkingBlock;
		if (thinkingCollapsed && messageHasThinkingContent(message)) {
			// Pi wraps this in theme.italic/fg again — keep plain label for the placeholder pass.
			(this as any).hiddenThinkingLabel = "Thinking…";
		}
		// Call original to build all children (text, thinking, spacers, errors).
		// `hideThinkingBlock` is passed through untouched: hidden thinking never renders
		// a live body, so there is no reason to temporarily reveal it here.
		originalUpdateContent.call(this, message, isStreaming);
		// Plain prose keeps Pi's Markdown child (flush left, stock spacing); only prose
		// that needs display math or status-glyph cleanup gets the custom renderer.
		const container = (this as any).contentContainer;
		if (!container?.children) return;
		if (thinkingCollapsed && messageHasThinkingContent(message)) {
			replaceHiddenThinkingPlaceholders(container, message);
		}
		const mdTheme = (this as any).markdownTheme;
		for (let i = container.children.length - 1; i >= 0; i--) {
			const child = container.children[i];
			if (isMarkdownComponent(child)) {
				const text = (child as any).text;
				if (!text) continue;
				const isThinking = !!(child as any).defaultTextStyle?.italic;
				if (isThinking) {
					const style = (child as any).defaultTextStyle;
					container.children[i] = new ThinkingParagraph(text, mdTheme, style);
				} else if (needsFlushParagraph(text)) {
					container.children[i] = new FlushParagraph(text, mdTheme);
				}
			}
		}
		const explicitDuration = (message as any)[WORKED_DURATION_KEY];
		const explicitSessionTotal = (message as any)[WORKED_SESSION_TOTAL_KEY];
		const explicitTurns = (message as any)[WORKED_TURNS_KEY];
		// The "Agent took" line must only appear once the stream has truly closed.
		// `message.stopReason === "stop"` is not a safe "finished" signal here because
		// providers may initialize a live message with that value. The `message_end`
		// handler stamps `explicitDuration` after the final stream event. Render the
		// styled line as a TUI child so ANSI presentation never enters message content
		// or persisted session transcripts.
		const isFinalAssistantMessage = message.stopReason === "stop";
		const workedDuration = typeof explicitDuration === "number" ? explicitDuration : undefined;
		const workedSessionTotal = typeof explicitSessionTotal === "number"
			? explicitSessionTotal
			: sessionWorkedTotalMs > 0
				? sessionWorkedTotalMs
				: undefined;
		const workedTurns = typeof explicitTurns === "number" ? explicitTurns : lastRunTurnCount;
		const hasAssistantText = message.content.some((block: any) => block?.type === "text" && typeof block.text === "string" && block.text.trim());
		if (typeof workedDuration === "number" && isFinalAssistantMessage && hasAssistantText && !hasWorkedDurationLine(message)) {
			container.children.push(new Spacer(1), new Text(workedDurationText(workedDuration, workedSessionTotal, workedTurns), 1, 0));
		}
	};
	proto[ASSISTANT_PATCH_FLAG] = true;
}

const TOOL_BG_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-tool-bg-sync");

function patchToolExecutionBackgroundSync(): void {
	const proto = ToolExecutionComponent.prototype as any;
	if (proto[TOOL_BG_PATCH_FLAG]) return;
	const originalUpdateDisplay = proto.updateDisplay;
	if (typeof originalUpdateDisplay !== "function") return;
	proto.updateDisplay = function patchedToolBackgroundSync(this: any) {
		syncToolBackgroundMode();
		applyToolBackgroundMode(getGlobalPiTheme());
		return originalUpdateDisplay.apply(this, arguments as any);
	};
	proto[TOOL_BG_PATCH_FLAG] = true;
}

function syncLiveToolRenderState(component: any): void {
	// updateDisplay paints call header BEFORE result. Pre-seed status + live line
	// count so the header's blinking ● and `(N lines)` trail stay in sync with
	// the partial result that is about to render underneath.
	const state = component?.rendererState;
	if (!state || typeof state !== "object") return;
	const ctxLike = {
		state,
		isPartial: component?.isPartial === true,
		executionStarted: component?.executionStarted === true,
		isError: component?.result?.isError === true,
	};
	syncToolCallStatus(ctxLike);
	if (component?.isPartial === true && component?.result) {
		const raw = getTextContent(component.result).replace(/\r\n/g, "\n").trimEnd();
		// tailLimit=0 → count-only (no line materialization) so huge bash tails stay cheap.
		state._liveLineCount = collectNonEmptyLines(raw, 0).total;
	} else if (component?.isPartial !== true) {
		delete state._liveLineCount;
	}
}

function patchToolRenderCacheInvalidation(): void {
	const proto = ToolExecutionComponent.prototype as any;
	if (proto[TOOL_CACHE_PATCH_FLAG]) return;

	const methods = [
		"updateDisplay",
		"updateArgs",
		"markExecutionStarted",
		"setArgsComplete",
		"updateResult",
		"setExpanded",
		"setShowImages",
		"setImageWidthCells",
		"invalidate",
	];

	for (const method of methods) {
		const original = proto[method];
		if (typeof original !== "function") continue;
		proto[method] = function patchedToolMutation(...args: any[]) {
			clearToolRenderCache(this);
			if (method === "updateDisplay" || method === "updateResult" || method === "invalidate") {
				syncLiveToolRenderState(this);
			}
			const result = original.apply(this, args);
			clearToolRenderCache(this);
			return result;
		};
	}

	proto[TOOL_CACHE_PATCH_FLAG] = true;
}

function deleteRenderedKittyImages(component: any): void {
	if (!process.stdout.isTTY || getCapabilities().images !== "kitty" || !Array.isArray(component.imageComponents) || component.imageComponents.length === 0) return;
	try { process.stdout.write(deleteAllKittyImages()); } catch { /* noop */ }
}

function removeImageChildren(component: any): void {
	deleteRenderedKittyImages(component);
	const children = [
		...(Array.isArray(component.imageComponents) ? component.imageComponents : []),
		...(Array.isArray(component.imageSpacers) ? component.imageSpacers : []),
	];
	for (const child of children) {
		try { component.removeChild?.(child); } catch { /* noop */ }
	}
	component.imageComponents = [];
	component.imageSpacers = [];
}

function patchReadImageExpansion(): void {
	const proto = ToolExecutionComponent.prototype as any;
	if (proto[TOOL_IMAGE_EXPAND_PATCH_FLAG]) return;
	const originalUpdateDisplay = proto.updateDisplay;
	if (typeof originalUpdateDisplay !== "function") return;
	proto.updateDisplay = function patchedReadImageUpdateDisplay(...args: any[]) {
		const result = originalUpdateDisplay.apply(this, args);
		const hasImage = Array.isArray(this.result?.content) && this.result.content.some((block: any) => block?.type === "image");
		if (this.toolName === "read" && hasImage && this.expanded !== true) {
			removeImageChildren(this);
			clearToolRenderCache(this);
		}
		return result;
	};
	proto[TOOL_IMAGE_EXPAND_PATCH_FLAG] = true;
}

function patchToolExecutionRenderers(): void {
	const proto = ToolExecutionComponent.prototype as any;
	if (proto[TOOL_EXECUTION_PATCH_FLAG]) return;

	const originalHasRendererDefinition = proto.hasRendererDefinition;
	const originalGetCallRenderer = proto.getCallRenderer;
	const originalGetResultRenderer = proto.getResultRenderer;

	if (typeof originalHasRendererDefinition === "function") {
		proto.hasRendererDefinition = function patchedHasRendererDefinition() {
			return originalHasRendererDefinition.call(this) || shouldUseGenericToolRenderer(this?.toolName);
		};
	}

	proto.getCallRenderer = function patchedGetCallRenderer() {
		const toolName = typeof this?.toolName === "string" ? this.toolName : "";
		if (toolName === "apply_patch") {
			return (args: any, theme: Theme, ctx: any) =>
				renderApplyPatchCall(args, theme, ctx, (path: string) => shortPath(ctx.cwd ?? process.cwd(), path));
		}
		if (shouldUseGenericToolRenderer(toolName)) {
			const registeredLabel = typeof this?.toolDefinition?.label === "string" ? this.toolDefinition.label.trim() : "";
			return (args: any, theme: Theme, ctx: any) => renderGenericToolCall(toolName, args, theme, ctx, registeredLabel);
		}
		return typeof originalGetCallRenderer === "function" ? originalGetCallRenderer.call(this) : undefined;
	};

	proto.getResultRenderer = function patchedGetResultRenderer() {
		const toolName = typeof this?.toolName === "string" ? this.toolName : "";
		let renderer: any;
		if (toolName === "apply_patch") {
			renderer = (result: any, options: any, theme: Theme, ctx: any) =>
				renderApplyPatchResult({ content: result.content, details: result.details }, options.isPartial, theme, ctx);
		} else if (typeof originalGetResultRenderer === "function" && typeof originalGetResultRenderer.call(this) === "function") {
			renderer = originalGetResultRenderer.call(this);
		} else if (shouldUseGenericToolRenderer(toolName)) {
			renderer = (result: any, options: any, theme: Theme, ctx: any) =>
				renderGenericToolResult(toolName, result, options, theme, ctx);
		} else {
			renderer = typeof originalGetResultRenderer === "function" ? originalGetResultRenderer.call(this) : undefined;
		}
		if (typeof renderer !== "function") return renderer;
		// Strip transient Magic Context tags from the text the renderer sees,
		// without touching the stored result message.
		return (result: any, options: any, theme: Theme, ctx: any) => renderer(sanitizeToolResultForDisplay(result), options, theme, ctx);
	};

	// Fallback path for tools without a renderer definition formats raw text.
	const originalFormatToolExecution = proto.formatToolExecution;
	if (typeof originalFormatToolExecution === "function") {
		proto.formatToolExecution = function patchedFormatToolExecution(this: any, ...args: any[]) {
			const formatted = originalFormatToolExecution.apply(this, args);
			return typeof formatted === "string" ? stripTransientMagicContextTags(formatted) : formatted;
		};
	}

	proto[TOOL_EXECUTION_PATCH_FLAG] = true;
}

function shortPath(cwd: string, filePath: string): string {
	// Tool arguments come straight from the model — any shape can arrive, and a
	// throw here crashes the whole TUI render loop.
	if (typeof filePath !== "string") {
		if (filePath === undefined || filePath === null) return "";
		try {
			filePath = String(filePath);
		} catch {
			return "";
		}
	}
	if (!filePath) return "";
	try {
		const rel = relative(cwd, filePath);
		if (!rel.startsWith("..") && !rel.startsWith("/")) return rel || ".";
	} catch {
		// Not a comparable path — fall through to the literal value below.
	}
	const home = process.env.HOME ?? "";
	return home ? filePath.replace(home, "~") : filePath;
}

// ---------------------------------------------------------------------------
// Status dot — flickers green/gray while pending
// ---------------------------------------------------------------------------

function isBlinkOn(): boolean {
	return Math.floor(Date.now() / 500) % 2 === 0;
}

function toolHeader(tool: string, summary: string, theme: Theme, prefix = "", trailing = ""): string {
	applyThemePaletteIfNeeded(theme);
	const label = theme.fg("toolTitle", theme.bold(tool));
	const body = summary
		? `${label} ${WRAP_MARK}${theme.fg("accent", summary)}`
		: label;
	return trailing ? `${prefix}${body}${trailing}` : `${prefix}${body}`;
}

function liveLineCountTrailing(ctx: any, theme: Theme): string {
	if (ctx?.isPartial !== true) return "";
	const count = ctx?.state?._liveLineCount;
	if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return "";
	return ` ${theme.fg("muted", `(${lineCountLabel(count)})`)}`;
}

const BASH_STARTED_AT_KEY = "_bashStartedAtMs";
const BASH_ENDED_AT_KEY = "_bashEndedAtMs";

type BashDurationEntry = { invalidate: () => void };

const BASH_DURATION_CONTEXTS = new Map<any, BashDurationEntry>();
let bashDurationTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleBashDurationTick(): void {
	if (bashDurationTimer || BASH_DURATION_CONTEXTS.size === 0) return;
	bashDurationTimer = setTimeout(() => {
		bashDurationTimer = null;
		for (const entry of BASH_DURATION_CONTEXTS.values()) {
			try { entry.invalidate(); } catch { /* noop */ }
		}
		scheduleBashDurationTick();
	}, 1_000);
	unrefTimer(bashDurationTimer);
}

function registerBashDurationContext(ctx: any): void {
	const key = ctx?.state ?? ctx;
	if (!key) return;
	const invalidate = typeof ctx?.invalidate === "function" ? () => safeInvalidate(ctx) : () => {};
	BASH_DURATION_CONTEXTS.set(key, { invalidate });
	scheduleBashDurationTick();
}

function clearBashDurationContext(ctx: any): void {
	const key = ctx?.state ?? ctx;
	if (key) BASH_DURATION_CONTEXTS.delete(key);
	if (bashDurationTimer && BASH_DURATION_CONTEXTS.size === 0) {
		clearTimeout(bashDurationTimer);
		bashDurationTimer = null;
	}
}

function clearAllBashDurationContexts(): void {
	BASH_DURATION_CONTEXTS.clear();
	if (bashDurationTimer) {
		clearTimeout(bashDurationTimer);
		bashDurationTimer = null;
	}
}

function syncBashDuration(ctx: any, isPartial = true): void {
	const state = ctx?.state;
	if (!state) return;
	if (state._toolStatus === "pending" && typeof state[BASH_STARTED_AT_KEY] !== "number") {
		state[BASH_STARTED_AT_KEY] = Date.now();
		delete state[BASH_ENDED_AT_KEY];
	}
	const startedAt = state[BASH_STARTED_AT_KEY];
	if (typeof startedAt !== "number") return;
	if (!isPartial || ctx?.isError) {
		if (typeof state[BASH_ENDED_AT_KEY] !== "number") state[BASH_ENDED_AT_KEY] = Date.now();
		clearBashDurationContext(ctx);
		return;
	}
	registerBashDurationContext(ctx);
}

function bashHeaderTrailing(ctx: any, theme: Theme): string {
	const parts: string[] = [];
	if (ctx?.isPartial === true) {
		const count = ctx?.state?._liveLineCount;
		if (typeof count === "number" && Number.isFinite(count) && count > 0) parts.push(lineCountLabel(count));
	}
	const startedAt = ctx?.state?.[BASH_STARTED_AT_KEY];
	if (typeof startedAt === "number") {
		const endedAt = ctx?.state?.[BASH_ENDED_AT_KEY];
		parts.push(formatBashDuration((typeof endedAt === "number" ? endedAt : Date.now()) - startedAt));
	}
	return parts.length > 0 ? `${TRAILING_MARK}${theme.fg("muted", parts.join(" · "))}` : "";
}

function setToolStatus(ctx: any, status: "pending" | "success" | "error" | "idle"): void {
	if (ctx?.state) ctx.state._toolStatus = status;
}

function syncToolCallStatus(ctx: any): void {
	if (ctx?.isPartial) {
		// Blink only for tools that actually started in the current agent run.
		// History rebuilds (resume, compaction, /tree) leave unmatched tool calls
		// with isPartial=true forever and never set executionStarted — those must
		// render settled, not keep a pending blink alive across sessions.
		const agentLive = currentAgentWorkStartMs !== undefined;
		const started = ctx?.executionStarted === true;
		if (agentLive && started) {
			setToolStatus(ctx, "pending");
			return;
		}
		if (agentLive && !started) {
			// Args still streaming before tool_execution_start — static, no blink.
			setToolStatus(ctx, "idle");
			clearBlinkTimer(ctx);
			return;
		}
		setToolStatus(ctx, "success");
		clearBlinkTimer(ctx);
		return;
	}
	setToolStatus(ctx, ctx.isError ? "error" : "success");
	clearBlinkTimer(ctx);
}

function shouldRevealCallArgs(ctx: any): boolean {
	if (ctx?.argsComplete === true || ctx?.executionStarted === true) return true;
	const args = ctx?.args;
	if (!args || typeof args !== "object") return false;
	return Object.keys(args).some((key) => args[key] !== undefined && args[key] !== null && args[key] !== "");
}

function stableCallSummary(ctx: any, key: string, build: () => string, reveal = shouldRevealCallArgs(ctx)): string {
	const state = ctx?.state;
	const cached = state?.[key];
	const completeKey = `${key}Complete`;
	if (!reveal) return typeof cached === "string" ? cached : "";
	if (ctx?.argsComplete === true && state?.[completeKey] === true && typeof cached === "string") return cached;
	if (!shouldRevealCallArgs(ctx) && typeof cached === "string" && cached) return cached;
	const summary = build();
	if (state) {
		state[key] = summary;
		if (ctx?.argsComplete === true) state[completeKey] = true;
		else delete state[completeKey];
	}
	return summary;
}

function hasOwnArg(args: any, key: string): boolean {
	return !!args && Object.prototype.hasOwnProperty.call(args, key);
}

function fileExistsForTool(cwd: string, filePath: string): boolean {
	if (!filePath) return false;
	try {
		return existsSync(resolve(cwd, filePath));
	} catch {
		return false;
	}
}

const WRITE_EXISTED_BEFORE = new Map<string, boolean>();
const WRITE_CONTENT_BEFORE = new Map<string, string | undefined>();
const MAX_PENDING_DIFF_READ_BYTES = 1_000_000;

interface RtkRewriteRecord {
	original: string;
	rewritten: string;
	notice: string;
}

const RTK_ORIGINAL_BASH_COMMANDS = new Map<string, string>();
const RTK_REWRITES_BY_TOOL_ID = new Map<string, RtkRewriteRecord>();
const RTK_PENDING_REWRITES: RtkRewriteRecord[] = [];
const RTK_PENDING_REWRITE_LIMIT = 20;
const PRESERVED_BASH_PREVIEWS = new Set<string>();
const BASH_PREVIEW_INVALIDATORS = new Map<string, () => void>();

function preserveBashPreview(ctx: any): void {
	const toolCallId = typeof ctx?.toolCallId === "string" ? ctx.toolCallId : undefined;
	if (!toolCallId) return;
	PRESERVED_BASH_PREVIEWS.add(toolCallId);
	if (typeof ctx?.invalidate === "function") {
		BASH_PREVIEW_INVALIDATORS.set(toolCallId, () => safeInvalidate(ctx));
	}
}

function clearPreservedBashPreviews(): void {
	if (PRESERVED_BASH_PREVIEWS.size === 0) return;
	const invalidators = [...PRESERVED_BASH_PREVIEWS]
		.map((toolCallId) => BASH_PREVIEW_INVALIDATORS.get(toolCallId))
		.filter((invalidate): invalidate is () => void => typeof invalidate === "function");
	PRESERVED_BASH_PREVIEWS.clear();
	BASH_PREVIEW_INVALIDATORS.clear();
	for (const invalidate of invalidators) {
		try { invalidate(); } catch { /* noop */ }
	}
}

function shouldPreserveBashPreview(ctx: any): boolean {
	return typeof ctx?.toolCallId === "string" && PRESERVED_BASH_PREVIEWS.has(ctx.toolCallId);
}

function normalizeRtkCommandPreview(command: string): string {
	return command.replace(/\s+/g, " ").trim();
}

function rtkPreviewMatches(command: string, preview: string): boolean {
	const normalized = normalizeRtkCommandPreview(command);
	const normalizedPreview = normalizeRtkCommandPreview(preview);
	if (!normalized || !normalizedPreview) return false;
	if (normalized === normalizedPreview) return true;
	if (normalizedPreview.endsWith("…")) {
		return normalized.startsWith(normalizedPreview.slice(0, -1));
	}
	return normalized.startsWith(normalizedPreview) || normalizedPreview.startsWith(normalized);
}

function parseRtkRewriteNotice(message: string): RtkRewriteRecord | undefined {
	const match = message.match(/^RTK rewrite:\s*(.*?)\s*->\s*(.+)$/s);
	if (!match) return undefined;
	const original = match[1]?.trim() ?? "";
	const rewritten = match[2]?.trim() ?? "";
	if (!original || !rewritten) return undefined;
	return { original, rewritten, notice: message };
}

function rememberPendingRtkRewrite(record: RtkRewriteRecord): void {
	RTK_PENDING_REWRITES.push(record);
	while (RTK_PENDING_REWRITES.length > RTK_PENDING_REWRITE_LIMIT) RTK_PENDING_REWRITES.shift();
}

function findRtkRewriteToolId(record: RtkRewriteRecord): string | undefined {
	const entries = [...RTK_ORIGINAL_BASH_COMMANDS.entries()].reverse();
	return entries.find(([, command]) => rtkPreviewMatches(command, record.original))?.[0];
}

function rememberRtkRewrite(record: RtkRewriteRecord): void {
	const toolCallId = findRtkRewriteToolId(record);
	if (toolCallId) {
		RTK_REWRITES_BY_TOOL_ID.set(toolCallId, record);
		return;
	}
	rememberPendingRtkRewrite(record);
}

function takePendingRtkRewrite(originalCommand: string | undefined, currentCommand: string | undefined): RtkRewriteRecord | undefined {
	const index = RTK_PENDING_REWRITES.findIndex((record) => {
		return (!!originalCommand && rtkPreviewMatches(originalCommand, record.original))
			|| (!!currentCommand && (rtkPreviewMatches(currentCommand, record.rewritten) || rtkPreviewMatches(currentCommand, record.original)));
	});
	if (index === -1) return undefined;
	const [record] = RTK_PENDING_REWRITES.splice(index, 1);
	return record;
}

function ensureRtkRewriteForContext(ctx: any, args: any): RtkRewriteRecord | undefined {
	if (ctx?.state?._rtkRewriteRecord) return ctx.state._rtkRewriteRecord as RtkRewriteRecord;
	const toolCallId = typeof ctx?.toolCallId === "string" ? ctx.toolCallId : undefined;
	const currentCommand = typeof args?.command === "string" ? args.command : undefined;
	const originalCommand = toolCallId ? RTK_ORIGINAL_BASH_COMMANDS.get(toolCallId) : undefined;
	if (!toolCallId) return undefined;

	let record = RTK_REWRITES_BY_TOOL_ID.get(toolCallId);
	if (!record) {
		record = takePendingRtkRewrite(originalCommand, currentCommand);
		if (record) RTK_REWRITES_BY_TOOL_ID.set(toolCallId, record);
	}
	if (!record && originalCommand && currentCommand && normalizeRtkCommandPreview(originalCommand) !== normalizeRtkCommandPreview(currentCommand)) {
		record = {
			original: originalCommand,
			rewritten: currentCommand,
			notice: `RTK rewrite: ${originalCommand} -> ${currentCommand}`,
		};
		RTK_REWRITES_BY_TOOL_ID.set(toolCallId, record);
	}
	if (record && ctx?.state) ctx.state._rtkRewriteRecord = record;
	return record;
}

function formatRtkRewriteDetails(record: RtkRewriteRecord, theme: Theme): string {
	return [
		theme.fg("muted", "RTK rewrite"),
		`${theme.fg("muted", "original :")} ${theme.fg("dim", record.original)}`,
		`${theme.fg("muted", "rewritten:")} ${theme.fg("dim", record.rewritten)}`,
	].join("\n");
}

function patchUiNotifications(ui: any): void {
	if (!ui || ui[UI_NOTIFY_PATCH_FLAG]) return;
	const originalNotify = ui.notify;
	if (typeof originalNotify !== "function") return;
	ui.notify = function patchedUiNotify(message: string, type?: "info" | "warning" | "error") {
		if (typeof message === "string") {
			const rewrite = parseRtkRewriteNotice(message);
			if (rewrite) {
				rememberRtkRewrite(rewrite);
				return;
			}
			if (message === "💾 Memory auto-reviewed and updated") {
				applyThemePaletteIfNeeded(ui.theme);
				message = `${BORDER_COLOR}✻ Memory auto-reviewed and updated${TRANSPARENT_RESET}`;
			}
		}
		return originalNotify.call(this, message, type);
	};
	ui[UI_NOTIFY_PATCH_FLAG] = true;
}

function trackRtkOriginalBashCommand(toolCallId: unknown, args: unknown): void {
	if (typeof toolCallId !== "string") return;
	const command = (args as any)?.command;
	if (typeof command === "string" && command.trim()) {
		RTK_ORIGINAL_BASH_COMMANDS.set(toolCallId, command);
	}
}

function forgetRtkBashCommand(toolCallId: unknown): void {
	if (typeof toolCallId !== "string") return;
	RTK_ORIGINAL_BASH_COMMANDS.delete(toolCallId);
	RTK_REWRITES_BY_TOOL_ID.delete(toolCallId);
}

function clearRtkRewriteState(): void {
	RTK_ORIGINAL_BASH_COMMANDS.clear();
	RTK_REWRITES_BY_TOOL_ID.clear();
	RTK_PENDING_REWRITES.length = 0;
	clearPreservedBashPreviews();
}

function getWriteWasNewFile(ctx: any, cwd: string, filePath: string, reveal = shouldRevealCallArgs(ctx)): boolean | undefined {
	if (typeof ctx?.state?._writeWasNewFile === "boolean") return ctx.state._writeWasNewFile;
	if (!filePath || !reveal) return undefined;
	const existedBefore = typeof ctx?.toolCallId === "string" ? WRITE_EXISTED_BEFORE.get(ctx.toolCallId) : undefined;
	const wasNew = existedBefore === undefined ? !fileExistsForTool(cwd, filePath) : !existedBefore;
	if (ctx?.state) ctx.state._writeWasNewFile = wasNew;
	return wasNew;
}

interface PendingWriteBaseline {
	existed: boolean;
	content?: string;
	notice?: string;
}

function getPendingWriteBaseline(ctx: any, cwd: string, filePath: string): PendingWriteBaseline {
	const toolCallId = typeof ctx?.toolCallId === "string" ? ctx.toolCallId : undefined;
	if (toolCallId && WRITE_EXISTED_BEFORE.has(toolCallId)) {
		return {
			existed: WRITE_EXISTED_BEFORE.get(toolCallId) === true,
			content: WRITE_CONTENT_BEFORE.get(toolCallId),
		};
	}
	const key = `${cwd}\u0000${filePath}`;
	if (ctx?.state?._pendingWriteBaselineKey === key && ctx.state._pendingWriteBaseline) {
		return ctx.state._pendingWriteBaseline as PendingWriteBaseline;
	}
	let baseline: PendingWriteBaseline;
	try {
		const fullPath = resolve(cwd, filePath);
		if (!existsSync(fullPath)) {
			baseline = { existed: false };
		} else {
			const stats = statSync(fullPath);
			if (!stats.isFile()) {
				baseline = { existed: true, notice: "Preview unavailable: target is not a regular file." };
			} else if (stats.size > MAX_PENDING_DIFF_READ_BYTES) {
				baseline = { existed: true, notice: `Preview unavailable: existing file exceeds ${MAX_PENDING_DIFF_READ_BYTES} bytes.` };
			} else {
				baseline = { existed: true, content: readFileSync(fullPath, "utf8") };
			}
		}
	} catch (error) {
		baseline = {
			existed: true,
			notice: `Preview unavailable: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (ctx?.state) {
		ctx.state._pendingWriteBaselineKey = key;
		ctx.state._pendingWriteBaseline = baseline;
	}
	return baseline;
}

function toolStatusDot(ctx: any, theme: Theme): string {
	const status = ctx.state?._toolStatus as "pending" | "success" | "error" | "idle" | undefined;
	if (status === "success") return `${theme.fg("success", "✓")} `;
	if (status === "error") return `${theme.fg("error", "!")} `;
	if (status === "idle") return `${themeStatusDot(theme, "dim")} `;
	return `${blinkDot(ctx, theme)} `;
}

// ---------------------------------------------------------------------------
// Branch connector — visual tree from header to output
// ---------------------------------------------------------------------------

function branchIndent(text: string, continued = false, theme?: Theme): string {
	if (theme) _toolBranchThemeHint = theme;
	// Mutation/output rails share the light-theme activity gray rather than the
	// fixed near-black branch fallback used on dark panels.
	const rule = activityTreeBranchAnsi();
	// Align under bare `├ `/`╰ ` (│ + one space, or two spaces when closed).
	const prefix = continued ? `${rule}│${TRANSPARENT_RESET} ` : "  ";
	return `${prefix}${WRAP_MARK}${text}`;
}

function branchLead(text: string, continued = false, theme?: Theme): string {
	if (theme) _toolBranchThemeHint = theme;
	const rule = activityTreeBranchAnsi();
	// Bare tee/corner only — no horizontal ─ arm.
	return `${rule}${continued ? "├" : "╰"}${TRANSPARENT_RESET} ${WRAP_MARK}${text}`;
}

function withBranch(content: string, theme: Theme, _isError = false, continued = false): string {
	if (!content || !content.trim()) return "";
	const lines = content.split("\n");
	const first = lines[0] ?? "";
	if (lines.length === 1) return branchLead(first, continued, theme);
	const rest = lines.slice(1).map((line) => branchIndent(line, continued, theme));
	return `${branchLead(first, continued, theme)}\n${rest.join("\n")}`;
}

function withClippedBranch(content: string, theme: Theme, continued = false): string {
	return withBranch(content, theme, false, continued).replaceAll(WRAP_MARK, CLIP_MARK);
}

function withFinalBranchBlock(content: string, theme: Theme, isError = false): string {
	if (!content || !content.trim()) return "";
	const lines = content.split("\n");
	const first = lines[0] ?? "";
	if (lines.length === 1) return branchLead(first, false, theme);
	const middle = lines.slice(1, -1).map((line) => branchIndent(line, true, theme));
	const last = lines[lines.length - 1] ?? "";
	return [branchLead(first, true, theme), ...middle, branchLead(last, false, theme)].join("\n");
}

function indentBranchBlock(block: string): string {
	return block
		.split("\n")
		.map((line) => (line ? ` ${line}` : line))
		.join("\n");
}

// ---------------------------------------------------------------------------
// Blink timer for partial (running) states
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Global blink timer — single timer invalidates all active contexts
// ---------------------------------------------------------------------------

const MAX_BLINKING_TOOLS = 5;
const BLINK_INTERVAL_MS = 500;
// Safety net ONLY for leaked entries after the agent has stopped. Quiet
// long-running tools (sleep, sparse builds, waiting on network) legitimately
// emit no tool_execution_update for minutes — treating that silence as "stale"
// is what made their ● freeze mid-run.
const BLINK_STALE_TIMEOUT_MS = 15000;
let _lastBlinkActivity = 0;

function markBlinkActivity(): void {
	_lastBlinkActivity = Date.now();
}

type BlinkEntry = { key: any; order: number; invalidate: () => void };

const _blinkContexts = new Map<any, BlinkEntry>();
let _globalBlinkTimer: ReturnType<typeof setTimeout> | null = null;
let _blinkOrder = 0;
// Shared phase for all blinkers. Ordinary tools use even/odd (on/off ●).
// Agent-family tools map the index onto a 6-step size breath cycle.
let _globalBlinkPhaseIndex = 0;
let _globalBlinkPhase = true;
// Wall-clock of the last blink/breathe advance: the timer can tick faster than the
// dot cycle while a label shimmer is running.
let _lastBlinkPhaseAt = 0;
// Live-group repaint: refreshed by every render of a live chunk, consumed by the tick.
let _liveTickTimer: ReturnType<typeof setTimeout> | null = null;
let _liveTickTarget: (() => void) | null = null;
// The transcript that owns the running loop. Nested containers render through the same
// code path, so only the owner is allowed to stop it.
let _liveTickOwner: any = null;
let _liveTickFast = false;
// When the owning transcript last rendered. A chunk whose loop keeps ticking without
// ever being rendered again (hidden viewport, a re-render that never lands) is done:
// the loop would only burn frames painting a row nobody reads.
let _liveTickRenderedAt = 0;
const LIVE_TICK_STALE_MS = 4000;

function getBlinkIntervalMs(): number {
	// Only the braille spinner needs sub-blink frames; the breathe cycle steps on its own
	// 500ms beat and the shimmer's live-frame loop drives its own cadence.
	return _blinkContexts.size > 0 && pendingIndicatorMode() === "spinner" ? SPINNER_INTERVAL_MS : BLINK_INTERVAL_MS;
}

/**
 * Keep repainting while the trailing chunk is still the agent's live work.
 *
 * The grouped transcript draws its own status light and label shimmer, so it never goes
 * through the native tool row renderer that arms the ● blink. Without this loop a running
 * group rendered once and froze.
 *
 * The loop re-arms itself instead of waiting for the next render to restart it: a chunk
 * that keeps working after its last call settled (the model thinking, or composing the
 * next call) has nothing else asking for frames. Which transcript owns the loop, and
 * whether it is still live, is decided by that transcript's render — prose, a new
 * activity label, or the end of the run closes the chunk and clears the target.
 */
function requestLiveGroupFrame(owner: any, invalidate: () => void, fast: boolean): void {
	_liveTickOwner = owner;
	_liveTickTarget = invalidate;
	_liveTickFast = fast;
	_liveTickRenderedAt = Date.now();
	_scheduleLiveTick();
}

function _scheduleLiveTick(): void {
	if (!_liveTickTarget) return;
	// Every render re-arms the tick, so the cadence syncs to the transcript's own frames
	// (nothing double-repaints while the agent streams) and no dead handle can ever wedge
	// the loop for the rest of the session.
	if (_liveTickTimer) clearTimeout(_liveTickTimer);
	_liveTickTimer = setTimeout(() => {
		_liveTickTimer = null;
		const target = _liveTickTarget;
		if (!target) return;
		// Nothing rendered the owning transcript since the last frame: stop instead of
		// spinning forever. A later render re-arms the loop if the chunk is still live.
		if (Date.now() - _liveTickRenderedAt > LIVE_TICK_STALE_MS) {
			stopLiveGroupFrame();
			return;
		}
		try {
			target();
		} catch { /* the row may be gone after a reload/session switch */ }
		_scheduleLiveTick();
	}, _liveTickFast ? SHIMMER_INTERVAL_MS : BLINK_INTERVAL_MS);
	unrefTimer(_liveTickTimer);
}

/** Stop the loop. Callers that render pass their own component so a nested container
 *  render cannot kill the transcript's animation. */
function stopLiveGroupFrame(owner?: any): void {
	if (owner !== undefined && _liveTickOwner !== owner) return;
	_liveTickTarget = null;
	_liveTickOwner = null;
	if (_liveTickTimer) {
		clearTimeout(_liveTickTimer);
		_liveTickTimer = null;
	}
}

/** Request a frame. pi's component `invalidate()` only clears caches — the repaint has
 *  to be asked for, which is why a loop that only invalidated painted nothing at all. */
function requestLiveRepaint(component: any): void {
	const ui = component?.ui;
	if (ui && typeof ui.requestRender === "function") ui.requestRender();
	else component?.getRenderContext?.()?.invalidate?.();
}

function getBlinkKey(ctx: any): any {
	return ctx?.state ?? ctx;
}

function getBlinkingEntries(): BlinkEntry[] {
	return [..._blinkContexts.values()]
		.sort((a, b) => b.order - a.order)
		.slice(0, MAX_BLINKING_TOOLS);
}

function updateBlinkActiveStates(): void {
	const activeSet = new Set(getBlinkingEntries().map((entry) => entry.key));
	for (const entry of _blinkContexts.values()) {
		const active = activeSet.has(entry.key);
		if (entry.key?._blinkActive !== active) {
			entry.key._blinkActive = active;
			try { entry.invalidate(); } catch { /* noop */ }
		}
	}
}

function _clearAllBlinkContexts(): void {
	for (const entry of _blinkContexts.values()) {
		try { entry.key._blinkActive = false; } catch { /* noop */ }
	}
	_blinkContexts.clear();
	if (_globalBlinkTimer) {
		clearTimeout(_globalBlinkTimer);
		_globalBlinkTimer = null;
	}
	updateBlinkActiveStates();
}

function _scheduleGlobalBlinkTimer(): void {
	if (_globalBlinkTimer) return;
	const intervalMs = getBlinkIntervalMs();
	if (_blinkContexts.size === 0) return;
	_globalBlinkTimer = setTimeout(() => {
		_globalBlinkTimer = null;
		if (_blinkContexts.size === 0) {
			updateBlinkActiveStates();
			return;
		}
		// While an agent run is live, quiet tools are still in flight — keep blinking.
		// Heartbeat here so sparse/no-output commands never look "stale".
		if (currentAgentWorkStartMs !== undefined) {
			markBlinkActivity();
		} else if (_lastBlinkActivity && Date.now() - _lastBlinkActivity > BLINK_STALE_TIMEOUT_MS) {
			// Agent already finished; leftover entries are leaks. Stop the re-render storm.
			_clearAllBlinkContexts();
			return;
		}
		// The ● blink / Agent breathe cycle stays on its 500ms beat even when the
		// shimmer asks for a faster tick, so the dot never strobes.
		const now = Date.now();
		if (now - _lastBlinkPhaseAt >= BLINK_INTERVAL_MS) {
			_lastBlinkPhaseAt = now;
			_globalBlinkPhaseIndex = (_globalBlinkPhaseIndex + 1) % AGENT_BREATHE_LEN;
			_globalBlinkPhase = _globalBlinkPhaseIndex % 2 === 0;
		}
		for (const entry of getBlinkingEntries()) {
			try { entry.invalidate(); } catch { /* noop */ }
		}
		_scheduleGlobalBlinkTimer();
	}, intervalMs);
	unrefTimer(_globalBlinkTimer);
}

function _stopGlobalBlinkTimerIfEmpty(): void {
	if (_globalBlinkTimer && _blinkContexts.size === 0) {
		clearTimeout(_globalBlinkTimer);
		_globalBlinkTimer = null;
	}
}

function setupBlinkTimer(ctx: any): void {
	const key = getBlinkKey(ctx);
	if (!key) return;
	const invalidate = typeof ctx?.invalidate === "function" ? () => safeInvalidate(ctx) : () => {};
	const existing = _blinkContexts.get(key);
	if (existing) {
		// Already tracked — refresh invalidate + ensure the global timer is alive.
		// If a prior watchdog/pass stopped the timer without removing this entry
		// (or the timer simply died), a quiet long-running tool would otherwise
		// stay registered forever with a frozen ●.
		existing.invalidate = invalidate;
		markBlinkActivity();
		_scheduleGlobalBlinkTimer();
		return;
	}
	_blinkContexts.set(key, { key, order: ++_blinkOrder, invalidate });
	key._blinkActive = false;
	markBlinkActivity();
	updateBlinkActiveStates();
	_stopGlobalBlinkTimerIfEmpty();
	_scheduleGlobalBlinkTimer();
}

function clearBlinkTimer(ctx: any): void {
	const key = getBlinkKey(ctx);
	if (!key) return;
	_blinkContexts.delete(key);
	key._blinkActive = false;
	updateBlinkActiveStates();
	_stopGlobalBlinkTimerIfEmpty();
	_scheduleGlobalBlinkTimer();
}

function pendingToolChromeColor(theme: Theme): "dim" | "muted" | "thinkingText" {
	if (!themeAdaptiveEnabled()) return "muted";
	return "dim";
}

function blinkDot(ctx: any, theme: Theme): string {
	// Only true in-flight tools arm the blink timer. Idle partials (args still
	// streaming, or history rows left isPartial without a result) stay static.
	if (ctx?.state?._toolStatus !== "pending") {
		return themeStatusDot(theme, "dim");
	}
	setupBlinkTimer(ctx);
	const key = getBlinkKey(ctx);
	const mode = pendingIndicatorMode();
	// Only the classic dot has an off phase, and only while this row is tracked.
	if (mode === "dot" && key?._blinkActive !== true) return " ";
	// Agent-family tools breathe through sizes; ordinary tools use the configured light.
	if (ctx?.state?._agentBreathe === true) {
		return agentBreatheDot(theme);
	}
	if (mode === "spinner") return theme.fg("success", spinnerFrameGlyph());
	if (mode === "dot") return blinkPhaseOn() ? themeStatusDot(theme, "success") : " ";
	const glyph = agentBreatheGlyphRaw();
	return glyph === " " ? " " : theme.fg("success", glyph);
}

// ---------------------------------------------------------------------------
// File icons — Nerd Font glyphs (requires Nerd Font terminal)
// ---------------------------------------------------------------------------

const NF_DIR = `\x1b[38;2;100;140;220m\ue5ff\x1b[0m`;
const NF_DEFAULT = `\x1b[38;2;80;80;80m\uf15b\x1b[0m`;

const EXT_ICON: Record<string, string> = {
	ts: `\x1b[38;2;49;120;198m\ue628\x1b[0m`,
	tsx: `\x1b[38;2;49;120;198m\ue7ba\x1b[0m`,
	js: `\x1b[38;2;241;224;90m\ue74e\x1b[0m`,
	jsx: `\x1b[38;2;97;218;251m\ue7ba\x1b[0m`,
	py: `\x1b[38;2;55;118;171m\ue73c\x1b[0m`,
	rs: `\x1b[38;2;222;165;132m\ue7a8\x1b[0m`,
	go: `\x1b[38;2;0;173;216m\ue724\x1b[0m`,
	java: `\x1b[38;2;204;62;68m\ue738\x1b[0m`,
	rb: `\x1b[38;2;204;52;45m\ue739\x1b[0m`,
	swift: `\x1b[38;2;255;172;77m\ue755\x1b[0m`,
	c: `\x1b[38;2;85;154;211m\ue61e\x1b[0m`,
	cpp: `\x1b[38;2;85;154;211m\ue61d\x1b[0m`,
	html: `\x1b[38;2;228;77;38m\ue736\x1b[0m`,
	css: `\x1b[38;2;66;165;245m\ue749\x1b[0m`,
	scss: `\x1b[38;2;207;100;154m\ue749\x1b[0m`,
	vue: `\x1b[38;2;65;184;131m\ue6a0\x1b[0m`,
	svelte: `\x1b[38;2;255;62;0m\ue697\x1b[0m`,
	json: `\x1b[38;2;241;224;90m\ue60b\x1b[0m`,
	yaml: `\x1b[38;2;160;116;196m\ue6a8\x1b[0m`,
	yml: `\x1b[38;2;160;116;196m\ue6a8\x1b[0m`,
	toml: `\x1b[38;2;160;116;196m\ue6b2\x1b[0m`,
	md: `\x1b[38;2;66;165;245m\ue73e\x1b[0m`,
	sh: `\x1b[38;2;137;180;130m\ue795\x1b[0m`,
	bash: `\x1b[38;2;137;180;130m\ue795\x1b[0m`,
	zsh: `\x1b[38;2;137;180;130m\ue795\x1b[0m`,
	lua: `\x1b[38;2;81;160;207m\ue620\x1b[0m`,
	php: `\x1b[38;2;137;147;186m\ue73d\x1b[0m`,
	sql: `\x1b[38;2;218;218;218m\ue706\x1b[0m`,
	xml: `\x1b[38;2;228;77;38m\ue619\x1b[0m`,
	graphql: `\x1b[38;2;224;51;144m\ue662\x1b[0m`,
	dockerfile: `\x1b[38;2;56;152;236m\ue7b0\x1b[0m`,
	lock: `\x1b[38;2;130;130;130m\uf023\x1b[0m`,
	png: `\x1b[38;2;160;116;196m\uf1c5\x1b[0m`,
	jpg: `\x1b[38;2;160;116;196m\uf1c5\x1b[0m`,
	svg: `\x1b[38;2;255;180;50m\uf1c5\x1b[0m`,
	gif: `\x1b[38;2;160;116;196m\uf1c5\x1b[0m`,
};

const NAME_ICON: Record<string, string> = {
	"package.json": `\x1b[38;2;137;180;130m\ue71e\x1b[0m`,
	"tsconfig.json": `\x1b[38;2;49;120;198m\ue628\x1b[0m`,
	".gitignore": `\x1b[38;2;222;165;132m\ue702\x1b[0m`,
	"dockerfile": `\x1b[38;2;56;152;236m\ue7b0\x1b[0m`,
	"makefile": `\x1b[38;2;130;130;130m\ue615\x1b[0m`,
	"readme.md": `\x1b[38;2;66;165;245m\ue73e\x1b[0m`,
	"license": `\x1b[38;2;218;218;218m\ue60a\x1b[0m`,
};

function fileIcon(fp: string): string {
	const base = fp.split('/').pop()?.toLowerCase() ?? '';
	if (NAME_ICON[base]) return `${NAME_ICON[base]} `;
	const ext = base.includes('.') ? base.split('.').pop() ?? '' : '';
	return EXT_ICON[ext] ? `${EXT_ICON[ext]} ` : `${NF_DEFAULT} `;
}

function dirIcon(): string {
	return `${NF_DIR} `;
}

function lineCount(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}

function padToWidth(line: string, width: number): string {
	const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	const clipped = clampLineWidth(line, safeWidth);
	const padding = Math.max(0, safeWidth - visibleWidth(clipped));
	return `${clipped}${" ".repeat(padding)}`;
}

function markedContinuationPrefix(prefix: string): string {
	const plain = stripAnsi(prefix);
	// Match rounded/current leads plus legacy square/armed forms.
	const branchMatch = /^(\s*)(│  |│ |├─ |└─ |╰─ |├ |└ |╰ )/.exec(plain);
	if (branchMatch) {
		const indent = branchMatch[1];
		// Keep the same structure width as the lead glyph so wraps stay aligned.
		const pad = Math.max(0, visibleWidth(branchMatch[2]) - 1);
		return `${indent}${currentToolBranchAnsi()}│${TRANSPARENT_RESET}${" ".repeat(pad)}`;
	}
	return " ".repeat(visibleWidth(prefix));
}

function wrapMarkedLine(line: string, width: number): string[] {
	const clipIndex = line.indexOf(CLIP_MARK);
	if (clipIndex !== -1) {
		const prefix = line.slice(0, clipIndex);
		const body = line.slice(clipIndex + CLIP_MARK.length);
		if (body.includes(TRAILING_MARK)) return [alignTrailingMarkedLine(`${prefix}${body}`, width)];
		const bodyWidth = Math.max(1, width - visibleWidth(prefix));
		if (visibleWidth(body) <= bodyWidth) return [`${prefix}${body}`];
		const hint = "…";
		return [`${prefix}${truncateToWidth(body, Math.max(0, bodyWidth - visibleWidth(hint)), "", false)}${hint}`];
	}
	const markerIndex = line.indexOf(WRAP_MARK);
	if (markerIndex === -1) return wrapTextWithAnsi(line, width);
	const prefix = line.slice(0, markerIndex);
	const body = line.slice(markerIndex + WRAP_MARK.length);
	const prefixWidth = visibleWidth(prefix);
	const bodyWidth = Math.max(1, width - prefixWidth);
	const wrapped = wrapTextWithAnsi(body, bodyWidth);
	const continuation = markedContinuationPrefix(prefix);
	return wrapped.map((part, index) => (index === 0 ? `${prefix}${part}` : `${continuation}${part}`));
}

class ToolText extends Text {
	private value = "";
	private toolCachedValue?: string;
	private toolCachedWidth?: number;
	private toolCachedLines?: string[];
	private observedWidth?: number;
	private pendingObservedWidth?: number;
	private widthObserver?: (width: number) => void;
	private widthObserverScheduled = false;
	private responsiveDiff = false;

	constructor(text = "") {
		super("", 0, 0);
		this.value = text;
	}

	setText(text: string): void {
		if (this.value === text) return;
		this.value = text;
		this.invalidate();
	}

	setWidthObserver(observer?: (width: number) => void): void {
		this.widthObserver = observer;
		this.responsiveDiff = Boolean(observer);
		if (!observer) this.pendingObservedWidth = undefined;
	}

	private observeWidth(width: number): void {
		if (this.observedWidth === width) return;
		this.observedWidth = width;
		if (!this.widthObserver) return;
		this.pendingObservedWidth = width;
		if (this.widthObserverScheduled) return;
		this.widthObserverScheduled = true;
		queueMicrotask(() => {
			this.widthObserverScheduled = false;
			const observed = this.pendingObservedWidth;
			this.pendingObservedWidth = undefined;
			if (observed !== undefined) this.widthObserver?.(observed);
		});
	}

	invalidate(): void {
		this.toolCachedValue = undefined;
		this.toolCachedWidth = undefined;
		this.toolCachedLines = undefined;
	}

	render(width: number): string[] {
		// A split diff is an ANSI string laid out for one exact width, so the frame after a
		// resize must not re-wrap it: the width-keyed diff is rebuilt below and swapped in.
		// Keep the *previous* lines (re-padded) rather than collapsing to the heading: a
		// one-line frame shrinks the row by dozens of lines, which reflows the transcript
		// under the reader and is what makes scrolling jump. The stale layout is clipped to
		// the new width for a single frame instead.
		const reflowing = this.responsiveDiff && this.observedWidth !== undefined && this.observedWidth !== width;
		this.observeWidth(width);
		if (reflowing) {
			// Keep the row's shape: one output line per body line, clipped to the new width. Falling
			// back to the heading here collapsed the row to a single line whenever the width changed
			// in the same frame a freshly built diff landed (that invalidates the line cache), and a
			// row that shrinks by dozens of lines reflows the transcript under the reader. The
			// internal wrap/clip markers are consumed by the normal path, so drop them here too.
			const source = this.toolCachedLines && this.toolCachedLines.length > 1
				? this.toolCachedLines
				: this.value.split("\n");
			return source.map((line) => padToWidth(line.replaceAll(WRAP_MARK, "").replaceAll(CLIP_MARK, ""), width));
		}
		const branchKey = toolBranchRenderCacheKey();
		if (
			this.toolCachedLines
			&& this.toolCachedValue === this.value
			&& this.toolCachedWidth === width
			&& (this as any)._toolBranchCacheKey === branchKey
			&& (this as any)._toolBranchCacheEpoch === _toolBranchVisualEpoch
		) return this.toolCachedLines;
		if (!this.value || this.value.trim() === "") {
			this.toolCachedValue = this.value;
			this.toolCachedWidth = width;
			this.toolCachedLines = [];
			return this.toolCachedLines;
		}
		const contentWidth = Math.max(1, width);
		const lines = this.value.replace(/\t/g, "   ").split("\n");
		const rendered = lines
			.flatMap((line) => wrapMarkedLine(line, contentWidth))
			.map((line) => padToWidth(line, width));
		this.toolCachedValue = this.value;
		this.toolCachedWidth = width;
		this.toolCachedLines = rendered;
		(this as any)._toolBranchCacheKey = branchKey;
		(this as any)._toolBranchCacheEpoch = _toolBranchVisualEpoch;
		return rendered;
	}
}

/**
 * Number the pending build for a mutation row.
 *
 * Diff previews are built in the background (Shiki highlighting is async), and the stand-in
 * shown while one is pending is one or two lines tall. Two rules keep that from moving the
 * transcript under the reader:
 *
 * 1. A row keeps whatever diff it already shows until the new one is ready — only a row with
 *    nothing to show yet renders the placeholder, and a failed build leaves the previous body
 *    alone. Replacing a rendered diff with the placeholder is what collapsed rows to their
 *    red/green stat line and made scrolling jump.
 * 2. A slow build that has already been superseded must not land last. The old guard compared
 *    the row's build key, which also carried the diff width, so a width change mid-build threw
 *    the render away and left the row on its placeholder; a token only advances for a newer
 *    build of the same row.
 */
function beginDiffPreviewBuild(state: any, tokenName: string): number {
	const token = (typeof state?.[tokenName] === "number" ? state[tokenName] : 0) + 1;
	if (state) state[tokenName] = token;
	return token;
}

function isDiffPreviewBuildCurrent(state: any, tokenName: string, token: number): boolean {
	return state?.[tokenName] === token;
}

function makeText(last: unknown, text: string): Text {
	const component = last instanceof ToolText ? last : new ToolText();
	component.setWidthObserver();
	component.setText(text);
	return component;
}

function makeResponsiveDiffText(ctx: any, last: unknown, text: string): Text {
	const component = makeText(last, text) as ToolText;
	component.setWidthObserver((width) => {
		// Grouped rows seed this value before ToolText sees the new width. Equality
		// therefore does not mean the width-keyed renderer has already re-run: always
		// invalidate after an observed resize so the temporary reflow frame resolves.
		if (ctx.state && ctx.state._diffComponentWidth !== width) ctx.state._diffComponentWidth = width;
		safeInvalidate(ctx);
	});
	return component;
}

function previewLimit(): number {
	const value = readSettings().previewLines;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 8;
}

function expandedPreviewLimit(): number {
	const settings = readSettings();
	const key = extraToolOutputExpanded ? "extraExpandedPreviewMaxLines" : "expandedPreviewMaxLines";
	const value = settings[key];
	const fallback = extraToolOutputExpanded ? 12000 : 4000;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function bashCollapsedLimit(): number {
	const value = readSettings().bashCollapsedLines;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 10;
}

function bashCommandPreviewLimit(): number {
	const value = readSettings().bashCommandPreviewLines;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 8;
}

function renderBashCommandBlock(
	command: string,
	expanded: boolean,
	theme: Theme,
): string {
	const presentation = buildBashCommandPresentation(command);
	const limit = bashCommandPreviewLimit();
	if (!expanded && (limit === 0 || presentation.sourceLineCount < 2)) return "";
	const sourceLimit = expandedPreviewLimit();
	const lines = expanded ? presentation.sourceLines.slice(0, sourceLimit) : buildBashPreview(presentation.sourceLines, limit);
	if (lines.length === 0) return "";
	if (expanded && presentation.sourceLines.length > sourceLimit) {
		lines.push(`... ${presentation.sourceLines.length - sourceLimit} more command lines`);
	}
	const body = lines.map((line) => theme.fg("accent", line || " ")).join("\n");
	return expanded ? withBranch(body, theme, false, true) : withClippedBranch(body, theme, true);
}

function liveToolPreviewEnabled(): boolean {
	return readSettings().liveToolPreview !== false;
}

function liveToolPreviewLimit(): number {
	const value = readSettings().liveToolPreviewLines;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 5;
}

function diffCollapsedLimit(): number {
	const value = readSettings().diffCollapsedLines;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 24;
}

function collapsedPreviewCount(expanded: boolean, fallback: number): number {
	return expanded ? expandedPreviewLimit() : fallback;
}

function buildPreviewText(
	lines: string[],
	expanded: boolean,
	theme: Theme,
	fallbackCollapsed = 8,
	totalLineCount = lines.length,
	styleLine?: (line: string) => string,
): string {
	if (lines.length === 0 && totalLineCount === 0) return theme.fg("muted", "(no output)");
	const maxLines = collapsedPreviewCount(expanded, fallbackCollapsed);
	// Only style/join the lines we will actually display. Callers used to map
	// theme.fg over the entire output array first, which scaled with full tool
	// output even when only 8–10 lines were shown.
	const limit = Math.min(lines.length, maxLines);
	let text = "";
	for (let i = 0; i < limit; i++) {
		const line = styleLine ? styleLine(lines[i]) : lines[i];
		text += i === 0 ? line : `\n${line}`;
	}
	const remaining = Math.max(0, totalLineCount - limit);
	if (remaining > 0) {
		text += `${text ? "\n" : ""}${theme.fg("muted", `... (${remaining} more lines${toolOutputDetailHint(theme, expanded, true)})`)}`;
	}
	if (expanded && totalLineCount > maxLines) {
		text += `\n${theme.fg("warning", `(display capped at ${maxLines} lines${deepExpandHint()})`)}`;
	}
	return text;
}

// ===========================================================================
// Diff rendering — adapted from /tmp/pi-diff
// ===========================================================================

interface DiffPreset {
	name: string;
	description: string;
	shikiTheme?: string;
	bgAdd?: string;
	bgDel?: string;
	bgAddHighlight?: string;
	bgDelHighlight?: string;
	bgGutterAdd?: string;
	bgGutterDel?: string;
	bgEmpty?: string;
	fgAdd?: string;
	fgDel?: string;
	fgDim?: string;
	fgLnum?: string;
	fgRule?: string;
	fgStripe?: string;
	fgSafeMuted?: string;
}

interface DiffUserConfig {
	diffTheme?: string;
	diffColors?: Record<string, string>;
}

const DIFF_PRESETS: Record<string, DiffPreset> = {
	default: {
		name: "default",
		description: "Original pi-diff colors",
		bgAdd: "#162620",
		bgDel: "#2d1919",
		bgAddHighlight: "#234b32",
		bgDelHighlight: "#502323",
		bgGutterAdd: "#12201a",
		bgGutterDel: "#261616",
		bgEmpty: "#121212",
		fgDim: "#505050",
		fgLnum: "#646464",
		fgRule: "#323232",
		fgStripe: "#282828",
		fgSafeMuted: "#8b949e",
	},
	midnight: {
		name: "midnight",
		description: "Subtle tints for black backgrounds",
		bgAdd: "#0d1a12",
		bgDel: "#1a0d0d",
		bgAddHighlight: "#1a3825",
		bgDelHighlight: "#381a1a",
		bgGutterAdd: "#091208",
		bgGutterDel: "#120908",
		bgEmpty: "#080808",
		fgDim: "#404040",
		fgLnum: "#505050",
		fgRule: "#282828",
		fgStripe: "#1e1e1e",
		fgSafeMuted: "#8b949e",
	},
	neon: {
		name: "neon",
		description: "Higher contrast backgrounds",
		bgAdd: "#1a3320",
		bgDel: "#331a16",
		bgAddHighlight: "#2d5c3a",
		bgDelHighlight: "#5c2d2d",
		bgGutterAdd: "#142818",
		bgGutterDel: "#28120e",
		bgEmpty: "#141414",
		fgDim: "#606060",
		fgLnum: "#787878",
		fgRule: "#404040",
		fgStripe: "#303030",
		fgSafeMuted: "#9da5ae",
	},
};

function loadDiffConfig(): DiffUserConfig {
	const settings = readSettings();
	return { diffTheme: settings.diffTheme, diffColors: settings.diffColors };
}

// 6x6x6 color cube channel values used by pi's 256color fallback.
const CUBE_VALUES = [0, 95, 135, 175, 215, 255];

function xterm256ToRgb(index: number): { r: number; g: number; b: number } | null {
	if (!Number.isInteger(index) || index < 0 || index > 255) return null;
	if (index < 16) {
		// Standard 16 ANSI colors — terminal-defined, approximate with VS Code defaults.
		const basic: Array<[number, number, number]> = [
			[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
			[0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
			[128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
			[0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
		];
		const [r, g, b] = basic[index];
		return { r, g, b };
	}
	if (index < 232) {
		const i = index - 16;
		return {
			r: CUBE_VALUES[Math.floor(i / 36) % 6],
			g: CUBE_VALUES[Math.floor(i / 6) % 6],
			b: CUBE_VALUES[i % 6],
		};
	}
	const level = 8 + (index - 232) * 10;
	return { r: level, g: level, b: level };
}

function parseAnsiRgb(ansi: string): { r: number; g: number; b: number } | null {
	if (!ansi) return null;
	const esc = "\u001b";
	// Truecolor: \e[38;2;R;G;Bm or \e[48;2;R;G;Bm
	const tc = ansi.match(new RegExp(`${esc}\\[(?:38|48);2;(\\d+);(\\d+);(\\d+)m`));
	if (tc) return { r: +tc[1], g: +tc[2], b: +tc[3] };
	// 256-color: \e[38;5;Nm or \e[48;5;Nm — happens on Apple Terminal, screen, etc.
	const idx = ansi.match(new RegExp(`${esc}\\[(?:38|48);5;(\\d+)m`));
	if (idx) return xterm256ToRgb(+idx[1]);
	return null;
}

function hexToBgAnsi(hex: string): string {
	if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return "";
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `\x1b[48;2;${r};${g};${b}m`;
}

function hexToFgAnsi(hex: string): string {
	if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return "";
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m`;
}

// ---------------------------------------------------------------------------
// Theme palette extraction — pull RGB from the active pi theme so our
// hardcoded greys and accent colors track the user's selected theme.
//
// `theme.getFgAnsi(name)` / `theme.getBgAnsi(name)` return raw ANSI escapes
// (either truecolor or 256color depending on the terminal). We parse those
// back into RGB so we can mix tints for diff backgrounds.
// ---------------------------------------------------------------------------

type Rgb = { r: number; g: number; b: number };

function safeFgAnsi(theme: any, key: string): string | null {
	try {
		const ansi = theme?.getFgAnsi?.(key);
		return typeof ansi === "string" && ansi.length > 0 ? ansi : null;
	} catch {
		return null;
	}
}

function safeBgAnsi(theme: any, key: string): string | null {
	try {
		const ansi = theme?.getBgAnsi?.(key);
		return typeof ansi === "string" && ansi.length > 0 ? ansi : null;
	} catch {
		return null;
	}
}

function themeFgRgb(theme: any, key: string): Rgb | null {
	const ansi = safeFgAnsi(theme, key);
	return ansi ? parseAnsiRgb(ansi) : null;
}

function themeBgRgb(theme: any, key: string): Rgb | null {
	const ansi = safeBgAnsi(theme, key);
	return ansi ? parseAnsiRgb(ansi) : null;
}

// Cache theme identity so we only recompute on theme change. The Theme
// object is reused across renders within a single session unless the user
// switches themes via the picker.
let _themePaletteCacheTheme: unknown = null;
let _themePaletteCacheName: string | null = null;
let _themePaletteCacheFingerprint: string | null = null;

/** Resolved-color fingerprint so palette re-derives when the active theme file changes under the same name/object. */
function themePaletteFingerprint(theme: any): string {
	const keys = ["success", "error", "borderMuted", "accent", "muted", "toolDiffAdded", "toolDiffRemoved"] as const;
	return keys.map((k) => safeFgAnsi(theme, k) ?? "").join("\u001f");
}

function invalidateThemePaletteCache(): void {
	_themePaletteCacheTheme = null;
	_themePaletteCacheName = null;
	_themePaletteCacheFingerprint = null;
}

function themeAdaptiveEnabled(): boolean {
	const settings = readSettings();
	return settings.themeAdaptive !== false;
}

let DIFF_THEME: BundledTheme = (process.env.DIFF_THEME as BundledTheme | undefined) ?? "github-dark";
/** True when the active pi theme has a light panel background (edit/write diff chrome). */
let _diffOnLightBg = false;
let codeToAnsiLoader: Promise<any> | null = null;

const MAX_TERM_WIDTH = 210;
const DEFAULT_TERM_WIDTH = 200;
const MAX_PREVIEW_LINES = 60;
const MAX_RENDER_LINES = 150;
const MAX_HL_CHARS = 32_000;
const CACHE_LIMIT = 48;
const DIFF_RENDER_CONCURRENCY = 2;
const WORD_DIFF_MIN_SIM = 0.15;
const MAX_WRAP_ROWS_WIDE = 3;
const MAX_WRAP_ROWS_MED = 2;
const MAX_WRAP_ROWS_NARROW = 1;

let D_RST = "\x1b[0m";
const D_BOLD = "\x1b[1m";
const D_DIM = "\x1b[2m";

// Diff backgrounds — defaults are transparent; autoDeriveBgFromTheme fills them
// using pi-tool-display's mix ratios against the theme's toolSuccessBg.
let BG_ADD = "\x1b[49m";
let BG_DEL = "\x1b[49m";
let BG_ADD_W = "\x1b[49m";
let BG_DEL_W = "\x1b[49m";
let BG_GUTTER_ADD = "\x1b[49m";
let BG_GUTTER_DEL = "\x1b[49m";
let BG_EMPTY = "\x1b[49m";
let BG_BASE = "\x1b[49m";

let FG_ADD = "\x1b[38;2;100;180;120m";
let FG_DEL = "\x1b[38;2;200;100;100m";
let FG_DIM = "\x1b[38;2;80;80;80m";
let FG_LNUM = "\x1b[38;2;100;100;100m";
let FG_RULE = "\x1b[38;2;50;50;50m";
// Tool branch connectors (├ ╰ │). Default fixed gray 72 — independent of pi theme.
const DEFAULT_TOOL_BRANCH_GRAY = 72;

function toolBranchRgbAnsi(gray: number): string {
	const g = Math.max(0, Math.min(255, Math.round(gray)));
	return `\x1b[38;2;${g};${g};${g}m`;
}

function ansiRgbBrightenedBy(ansi: string, delta: number): string | null {
	const rgb = parseAnsiRgb(ansi);
	if (!rgb) return null;
	const bump = (c: number) => Math.max(0, Math.min(255, Math.round(c + delta)));
	return `\x1b[38;2;${bump(rgb.r)};${bump(rgb.g)};${bump(rgb.b)}m`;
}

/** Outline chrome always brighter than branch; never falls back to identical branch ANSI. */
function outlineChromeAnsiFromBranch(theme?: any): string {
	const t = theme ?? _toolBranchThemeHint;
	const branch = currentToolBranchAnsi(t);
	const fromBranch = ansiRgbBrightenedBy(branch, OUTLINE_CHROME_BRIGHTEN);
	if (fromBranch) return fromBranch;
	let gray = DEFAULT_TOOL_BRANCH_GRAY;
	if (toolBranchColorModeFixed()) {
		gray = getConfiguredToolBranchGray();
	} else if (t) {
		const hint = safeFgAnsi(t, "dim") ?? safeFgAnsi(t, "muted") ?? safeFgAnsi(t, "borderMuted");
		const rgb = hint ? parseAnsiRgb(hint) : null;
		if (rgb) gray = Math.round((rgb.r + rgb.g + rgb.b) / 3);
	}
	return toolBranchRgbAnsi(Math.min(255, gray + OUTLINE_CHROME_BRIGHTEN));
}

function getConfiguredToolBranchGray(): number {
	const raw = readSettings().toolBranchRgbGray;
	return typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.min(255, Math.round(raw))) : DEFAULT_TOOL_BRANCH_GRAY;
}

function toolBranchColorModeFixed(): boolean {
	return readSettings().toolBranchColorMode !== "theme";
}

function toolBranchRenderCacheKey(): string {
	if (toolBranchColorModeFixed()) return `fixed:${getConfiguredToolBranchGray()}`;
	return `theme:${stripAnsi(TOOL_RULE)}`;
}

let _toolBranchVisualEpoch = 0;

function bumpToolBranchVisualEpoch(): void {
	_toolBranchVisualEpoch++;
}

/** On light panels, theme dim/muted can be nearly white — pull chrome toward mid-gray. */
function attenuateChromeAnsi(ansi: string, theme: any): string {
	const rgb = parseAnsiRgb(ansi);
	if (!rgb) return ansi;
	if (!isLightThemeBackground(theme)) return ansi;
	const lum = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
	// Already quiet enough on light backgrounds.
	if (lum <= 145) return ansi;
	const target = 118;
	const t = Math.min(1, (lum - 130) / 110);
	const mix = (c: number) => Math.round(c + (target - c) * t);
	return `\x1b[38;2;${mix(rgb.r)};${mix(rgb.g)};${mix(rgb.b)}m`;
}

/** Shared outline chrome: tool rules, code fences, branch connectors. */
function resolveThemeChromeFg(theme: any): string | null {
	if (!theme || !themeAdaptiveEnabled()) return null;
	const dim = safeFgAnsi(theme, "dim");
	const muted = safeFgAnsi(theme, "muted");
	const borderMuted = safeFgAnsi(theme, "borderMuted");
	const thinking = safeFgAnsi(theme, "thinkingText");
	const raw = dim ?? muted ?? borderMuted ?? thinking;
	return raw ? attenuateChromeAnsi(raw, theme) : null;
}

/** Resolve ├ ╰ │ color from settings + theme on every use (not a stale global). */
let _toolBranchThemeHint: any;

function currentToolBranchAnsi(theme?: any): string {
	const t = theme ?? _toolBranchThemeHint;
	if (toolBranchColorModeFixed()) {
		return toolBranchRgbAnsi(getConfiguredToolBranchGray());
	}
	const chrome = t ? resolveThemeChromeFg(t) : null;
	if (chrome) return chrome;
	return toolBranchRgbAnsi(getConfiguredToolBranchGray());
}

/** Quiet activity connectors; don't brighten thinking text along with the tree. */
function activityTreeBranchAnsi(): string {
	const settings = readSettings();
	const customGray = typeof settings.toolBranchRgbGray === "number" && Number.isFinite(settings.toolBranchRgbGray);
	if (!customGray && settings.toolBranchColorMode !== "theme" && isLightThemeBackground(_toolBranchThemeHint)) {
		return toolBranchRgbAnsi(176);
	}
	return currentToolBranchAnsi();
}

/** Code fences, thinking/thought: branch + OUTLINE_CHROME_BRIGHTEN (never same as branch). */
function syncOutlineChromeFromBranch(theme?: any): void {
	const outline = outlineChromeAnsiFromBranch(theme);
	const prevBorder = BORDER_COLOR;
	BORDER_COLOR = outline;
	WORKED_LINE_FG = outline;
	CODE_BLOCK_LANG_FG = outline;
	if (outline !== prevBorder) bumpToolBranchVisualEpoch();
}

function applyToolBranchColor(theme?: any): void {
	if (theme) _toolBranchThemeHint = theme;
	const prev = TOOL_RULE;
	TOOL_RULE = currentToolBranchAnsi(theme);
	if (TOOL_RULE !== prev) bumpToolBranchVisualEpoch();
	syncOutlineChromeFromBranch(theme);
}

/** Strip baked ├/╰/│ prefixes (plus legacy └) so branch color can be reapplied. */
function stripBranchMarkupLine(line: string): string {
	let plain = stripAnsi(line);
	plain = plain.replace(/^\s*[├└╰]─?\s*/, "");
	plain = plain.replace(/^\s*│\s{0,2}/, "");
	return plain;
}

function stripBranchMarkupBlock(text: string): string {
	return text
		.split("\n")
		.map((line) => (stripAnsi(line).trim() ? stripBranchMarkupLine(line) : line))
		.join("\n");
}

function liveBranchDisplay(state: Record<string, unknown> | undefined, theme: Theme): string | undefined {
	if (!state || typeof state !== "object") return undefined;
	const body = state._ptBody;
	if (typeof body === "string" && body.trim() && !body.includes("(rendering")) {
		return indentBranchBlock(withBranch(body, theme, false, true));
	}
	const display = state._ptDisplay;
	if (typeof display === "string" && display.trim()) {
		return indentBranchBlock(withBranch(stripBranchMarkupBlock(display), theme, false, true));
	}
	return undefined;
}

function refreshToolBranchDisplaysInState(state: Record<string, unknown> | undefined, theme: Theme): void {
	if (!state || typeof state !== "object") return;
	const body = state._ptBody;
	if (typeof body === "string" && body.trim() && !body.includes("(rendering")) {
		state._ptDisplay = indentBranchBlock(withBranch(body, theme, false, true));
		return;
	}
	const display = state._ptDisplay;
	if (typeof display === "string" && display.trim()) {
		const stripped = stripBranchMarkupBlock(display);
		state._ptDisplay = indentBranchBlock(withBranch(stripped, theme, false, true));
	}
}

function refreshAllToolBranchVisuals(ctx: any): void {
	_settingsCache = null;
	syncToolBackgroundMode();
	invalidateThemePaletteCache();
	applyToolBackgroundMode(ctx?.ui?.theme);
	applyToolBranchColor(ctx?.ui?.theme);
	bumpToolBranchVisualEpoch(); // always bust ToolText + container caches after /cc-tools branch
	// Tool rows recompute branch markup on next render (liveBranchDisplay + cache bust).
	if (ctx?.hasUI) {
		try {
			ctx.ui.setToolsExpanded(ctx.ui.getToolsExpanded());
			ctx.ui.invalidate?.();
			ctx.ui.requestRender?.();
		} catch { /* noop */ }
	}
}

/** Re-derive borders, branches, and diffs from the active pi theme (no cross-extension deps). */
function rebindUiChromeToTheme(ctx: any): void {
	if (!ctx?.hasUI) return;
	_settingsCache = null;
	syncToolBackgroundMode();
	const theme = ctx.ui?.theme;
	invalidateThemePaletteCache();
	clearHighlightCache();
	applyDiffPalette();
	applyToolBackgroundMode(theme);
	applyThemePaletteIfNeeded(theme);
	syncDiffShikiTheme(theme);
	if (themeAdaptiveEnabled() && theme?.getFgAnsi && !hasExplicitBgConfig) {
		autoDeriveBgFromTheme(theme);
		autoDerivePending = false;
	}
	bumpToolBranchVisualEpoch();
	refreshAllToolBranchVisuals(ctx);
}

function scheduleDeferredChromeRebind(ctx: any, delayMs = 0): void {
	const timer = setTimeout(() => {
		try {
			rebindUiChromeToTheme(ctx);
		} catch { /* noop */ }
	}, delayMs);
	unrefTimer(timer);
}

let TOOL_RULE = toolBranchRgbAnsi(DEFAULT_TOOL_BRANCH_GRAY);
let FG_SAFE_MUTED = "\x1b[38;2;139;148;158m";
let FG_STRIPE = "\x1b[38;2;40;40;40m";

let DIVIDER = `${FG_RULE}│${D_RST}`;

interface DiffColors {
	fgAdd: string;
	fgDel: string;
	fgCtx: string;
}

let DEFAULT_DIFF_COLORS: DiffColors = { fgAdd: FG_ADD, fgDel: FG_DEL, fgCtx: FG_DIM };
let autoDerivePending = true;
let hasExplicitBgConfig = false;

function mixBg(
	base: { r: number; g: number; b: number },
	accent: { r: number; g: number; b: number },
	intensity: number,
): string {
	const r = Math.round(base.r + (accent.r - base.r) * intensity);
	const g = Math.round(base.g + (accent.g - base.g) * intensity);
	const b = Math.round(base.b + (accent.b - base.b) * intensity);
	return `\x1b[48;2;${r};${g};${b}m`;
}

// pi-tool-display tint targets for diff palette derivation
const ADDITION_TINT_TARGET = { r: 84, g: 190, b: 118 };
const DELETION_TINT_TARGET = { r: 232, g: 95, b: 122 };
// Fallback panel bases when theme bg vars are unavailable
const FALLBACK_BASE_BG_DARK = { r: 32, g: 35, b: 42 };
const FALLBACK_BASE_BG_LIGHT = { r: 232, g: 233, b: 236 };

/** Panel background tool rows sit on, when the theme exposes one. */
function themePanelBgRgb(theme: any): Rgb | null {
	return (
		themeBgRgb(theme, "toolSuccessBg") ||
		themeBgRgb(theme, "userMessageBg") ||
		themeBgRgb(theme, "selectedBg")
	);
}

function isLightThemeBackground(theme: any): boolean {
	const panel = themePanelBgRgb(theme);
	if (panel) {
		const lum = 0.2126 * panel.r + 0.7152 * panel.g + 0.0722 * panel.b;
		return lum > 165;
	}
	const fg = themeFgRgb(theme, "text") || themeFgRgb(theme, "fg");
	if (fg) {
		const lum = 0.2126 * fg.r + 0.7152 * fg.g + 0.0722 * fg.b;
		return lum < 95;
	}
	return false;
}

function syncDiffShikiTheme(theme: any): void {
	if (process.env.DIFF_THEME) return;
	const config = loadDiffConfig();
	if (config.diffTheme) return;
	_diffOnLightBg = isLightThemeBackground(theme);
	DIFF_THEME = (_diffOnLightBg ? "github-light" : "github-dark") as BundledTheme;
	clearHighlightCache();
}
const UNIVERSAL_DIFF_ADD_FG = { r: 110, g: 210, b: 130 };
const UNIVERSAL_DIFF_DEL_FG = { r: 225, g: 110, b: 110 };

function mixRgb(
	a: { r: number; g: number; b: number },
	b: { r: number; g: number; b: number },
	ratio: number,
): { r: number; g: number; b: number } {
	return {
		r: a.r + (b.r - a.r) * ratio,
		g: a.g + (b.g - a.g) * ratio,
		b: a.b + (b.b - a.b) * ratio,
	};
}

function rgbToBgAnsi(c: { r: number; g: number; b: number }): string {
	return `\x1b[48;2;${Math.round(c.r)};${Math.round(c.g)};${Math.round(c.b)}m`;
}

/**
 * Base color for a shimmering activity label: the theme's primary text color. The sweep
 * runs from here to the band color, so a live label reads as the theme's own text lit up by
 * the palette's current thinking-level color.
 */
function shimmerBaseRgb(): Rgb {
	if (themeAdaptiveEnabled()) {
		const ansi =
			safeFgAnsi(_toolBranchThemeHint, "text") ?? safeFgAnsi(_toolBranchThemeHint, "muted");
		const rgb = ansi ? parseAnsiRgb(ansi) : null;
		if (rgb) return rgb;
	}
	return parseAnsiRgb(DEFAULT_LABEL_FG) ?? { r: 212, g: 212, b: 212 };
}

function rgbDistance(a: Rgb, b: Rgb): number {
	return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/** W3C relative luminance, for contrast checks against the panel. */
function relativeLuminance(c: Rgb): number {
	const channel = (value: number) => {
		const v = value / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** W3C contrast ratio between two colors. */
function contrastRatio(a: Rgb, b: Rgb): number {
	const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/**
 * The color the band peaks at: the active theme's color for the current thinking level, so
 * the sweep tracks /thinking, Shift+Tab, and model switches. A theme with no color for that
 * level falls back to its accent, and so does a context that never reported a level.
 */
function shimmerSweepRgb(): Rgb | null {
	if (!themeAdaptiveEnabled()) return null;
	const level = _thinkingLevel;
	const key = level ? THINKING_LEVEL_KEYS[level] : undefined;
	const keys = [
		...(key ? [key, ...(THINKING_LEVEL_COLOR_FALLBACKS[level as string] ?? [])] : []),
		...SHIMMER_FALLBACK_KEYS,
	];
	for (const candidate of keys) {
		const rgb = themeFgRgb(_toolBranchThemeHint, candidate);
		if (rgb) return rgb;
	}
	return null;
}

/**
 * Keep a level's color visible on the panel. Pi's muted levels sit close to the panel color
 * ("off" is usually a surface tone) and would sweep invisibly, so those step toward the
 * panel's emphasis color. A loud level is returned untouched: its chroma is the point.
 */
function readableOnPanel(rgb: Rgb, panel: Rgb | null, light: boolean): Rgb {
	if (!panel) return rgb;
	if (contrastRatio(rgb, panel) >= SHIMMER_MIN_CONTRAST) return rgb;
	const target = light ? { r: 12, g: 16, b: 18 } : { r: 255, g: 255, b: 255 };
	for (const push of [0.25, 0.45, 0.65]) {
		const candidate = mixRgb(rgb, target, push);
		if (contrastRatio(candidate, panel) >= SHIMMER_MIN_CONTRAST) return candidate;
	}
	return mixRgb(rgb, target, 0.65);
}

/**
 * The band's hot color: the current thinking level's theme color, kept visible against the
 * panel. With no level color — or one indistinguishable from the label — the sweep steps
 * away from the label instead: brighten on dark panels, deepen on light ones.
 */
function shimmerHighlightRgb(base: Rgb): Rgb {
	const light = isLightThemeBackground(_toolBranchThemeHint);
	const sweep = shimmerSweepRgb();
	const band = sweep && rgbDistance(base, sweep) >= SHIMMER_MIN_SWEEP_DELTA
		? readableOnPanel(sweep, themePanelBgRgb(_toolBranchThemeHint), light)
		: light
			? mixRgb(base, { r: 12, g: 16, b: 18 }, 0.75)
			: mixRgb(base, { r: 255, g: 255, b: 255 }, 0.92);
	return ensureBandContrast(base, band, light);
}

/**
 * Keep the band visibly different from the label's own color. A muted thinking level can
 * land close to the theme's text color, which left the sweep looking like a static word;
 * step the band away from the label until it separates.
 */
function ensureBandContrast(base: Rgb, band: Rgb, light: boolean): Rgb {
	if (rgbDistance(base, band) >= SHIMMER_MIN_BAND_DELTA) return band;
	const away = light ? { r: 12, g: 16, b: 18 } : { r: 255, g: 255, b: 255 };
	let out = band;
	for (const push of [0.3, 0.5, 0.7, 0.85]) {
		out = mixRgb(band, away, push);
		if (rgbDistance(base, out) >= SHIMMER_MIN_BAND_DELTA) return out;
	}
	return out;
}

/**
 * Paint `text` with a highlight band part-way across it. The band travels left to
 * right and wraps, so every re-render of a running group advances the wave.
 */
function shimmerTextAnsi(text: string): string {
	const length = text.length;
	if (length === 0) return "";
	const base = shimmerBaseRgb();
	const highlight = shimmerHighlightRgb(base);
	const band = Math.max(2, length * SHIMMER_BAND_RATIO);
	const phase = (Date.now() % SHIMMER_PERIOD_MS) / SHIMMER_PERIOD_MS;
	const center = -band + phase * (length + band * 2);
	let out = "";
	let lastAnsi = "";
	for (let i = 0; i < length; i++) {
		const distance = Math.abs(i + 0.5 - center) / band;
		// Cosine falloff: 1 at the band center, 0 once past the band edge. The exponent
		// tightens the skirt, so the band reads as a comet with a hot core rather than a
		// wash over the whole label.
		const falloff =
			distance >= 1 ? 0 : Math.pow(0.5 * (1 + Math.cos(Math.PI * distance)), SHIMMER_FALLOFF_POW);
		const rgb = mixRgb(base, highlight, falloff * SHIMMER_PEAK_MIX);
		const ansi = `\x1b[38;2;${Math.round(rgb.r)};${Math.round(rgb.g)};${Math.round(rgb.b)}m`;
		if (ansi !== lastAnsi) {
			out += ansi;
			lastAnsi = ansi;
		}
		out += text[i];
	}
	return `${out}${TRANSPARENT_RESET}`;
}

function autoDeriveBgFromTheme(theme: any): void {
	// Diff palette derivation.
	//
	// `toolDiffAdded` / `toolDiffRemoved` from the active pi theme give us the
	// fg accents. The base background is taken from `toolSuccessBg` (close to
	// the panel color the row will sit on) so the tinted backgrounds blend in
	// instead of forcing a hardcoded dark hue. Falls back to the universal
	// dark palette when the theme is unavailable or themeAdaptive=false.
	const useTheme = themeAdaptiveEnabled() && theme;
	const onLight = useTheme && isLightThemeBackground(theme);
	_diffOnLightBg = !!onLight;
	const addFgRgb = (useTheme && themeFgRgb(theme, "toolDiffAdded")) || UNIVERSAL_DIFF_ADD_FG;
	const delFgRgb = (useTheme && themeFgRgb(theme, "toolDiffRemoved")) || UNIVERSAL_DIFF_DEL_FG;
	const base =
		(useTheme && themeBgRgb(theme, "toolSuccessBg")) ||
		(useTheme && themeBgRgb(theme, "userMessageBg")) ||
		(onLight ? FALLBACK_BASE_BG_LIGHT : FALLBACK_BASE_BG_DARK);

	const addTint = mixRgb(addFgRgb, ADDITION_TINT_TARGET, 0.35);
	const delTint = mixRgb(delFgRgb, DELETION_TINT_TARGET, 0.65);

	FG_ADD = `\x1b[38;2;${Math.round(addFgRgb.r)};${Math.round(addFgRgb.g)};${Math.round(addFgRgb.b)}m`;
	FG_DEL = `\x1b[38;2;${Math.round(delFgRgb.r)};${Math.round(delFgRgb.g)};${Math.round(delFgRgb.b)}m`;
	BG_ADD = rgbToBgAnsi(mixRgb(base, addTint, 0.24));
	BG_DEL = rgbToBgAnsi(mixRgb(base, delTint, 0.12));
	BG_ADD_W = rgbToBgAnsi(mixRgb(base, addTint, 0.44));
	BG_DEL_W = rgbToBgAnsi(mixRgb(base, delTint, 0.26));
	BG_GUTTER_ADD = rgbToBgAnsi(mixRgb(base, addTint, 0.14));
	BG_GUTTER_DEL = rgbToBgAnsi(mixRgb(base, delTint, 0.08));
	BG_EMPTY = TRANSPARENT_BG;
	BG_BASE = TRANSPARENT_BG;
	D_RST = TRANSPARENT_RESET;
	DIVIDER = `${FG_RULE}│${D_RST}`;
	DEFAULT_DIFF_COLORS = { fgAdd: FG_ADD, fgDel: FG_DEL, fgCtx: FG_DIM };
}

// Track which palette fields the user explicitly set so theme-derived
// updates don't clobber their config.
const _explicitFgFields = new Set<"fgAdd" | "fgDel" | "fgDim" | "fgLnum" | "fgRule" | "fgStripe" | "fgSafeMuted">();

// Original Claude-Code-style palette captured at module-load so we can
// restore it when the user toggles themeAdaptive off at runtime.
const _claudeStyleDefaults = {
	BORDER_COLOR: "\x1b[38;5;238m",
	WORKED_LINE_FG: "\x1b[38;2;140;140;140m",
	CODE_BLOCK_LANG_FG: "\x1b[38;2;95;95;95m",
	TOOL_RULE: toolBranchRgbAnsi(DEFAULT_TOOL_BRANCH_GRAY),
	FG_DIM: "\x1b[38;2;80;80;80m",
	FG_LNUM: "\x1b[38;2;100;100;100m",
	FG_RULE: "\x1b[38;2;50;50;50m",
	FG_STRIPE: "\x1b[38;2;40;40;40m",
	FG_SAFE_MUTED: "\x1b[38;2;139;148;158m",
	FG_ADD: "\x1b[38;2;100;180;120m",
	FG_DEL: "\x1b[38;2;200;100;100m",
	TOOL_STATUS_SUCCESS: "\x1b[32m",
	TOOL_STATUS_ERROR: "\x1b[31m",
	TOOL_STATUS_PENDING: "\x1b[90m",
};

function resetThemePalette(): void {
	BORDER_COLOR = _claudeStyleDefaults.BORDER_COLOR;
	WORKED_LINE_FG = _claudeStyleDefaults.WORKED_LINE_FG;
	CODE_BLOCK_LANG_FG = _claudeStyleDefaults.CODE_BLOCK_LANG_FG;
	applyToolBranchColor();
	TOOL_STATUS_SUCCESS = _claudeStyleDefaults.TOOL_STATUS_SUCCESS;
	TOOL_STATUS_ERROR = _claudeStyleDefaults.TOOL_STATUS_ERROR;
	TOOL_STATUS_PENDING = _claudeStyleDefaults.TOOL_STATUS_PENDING;
	if (!_explicitFgFields.has("fgDim")) FG_DIM = _claudeStyleDefaults.FG_DIM;
	if (!_explicitFgFields.has("fgLnum")) FG_LNUM = _claudeStyleDefaults.FG_LNUM;
	if (!_explicitFgFields.has("fgRule")) FG_RULE = _claudeStyleDefaults.FG_RULE;
	if (!_explicitFgFields.has("fgStripe")) FG_STRIPE = _claudeStyleDefaults.FG_STRIPE;
	if (!_explicitFgFields.has("fgSafeMuted")) FG_SAFE_MUTED = _claudeStyleDefaults.FG_SAFE_MUTED;
	if (!_explicitFgFields.has("fgAdd")) FG_ADD = _claudeStyleDefaults.FG_ADD;
	if (!_explicitFgFields.has("fgDel")) FG_DEL = _claudeStyleDefaults.FG_DEL;
	DIVIDER = `${FG_RULE}│${D_RST}`;
	DEFAULT_DIFF_COLORS = { fgAdd: FG_ADD, fgDel: FG_DEL, fgCtx: FG_DIM };
}

function applyThemePaletteIfNeeded(theme: any): void {
	if (!theme) return;
	if (!themeAdaptiveEnabled()) {
		applyToolBranchColor(theme);
		syncOutlineChromeFromBranch(theme);
		return;
	}
	const themeName = typeof theme?.name === "string" ? theme.name : "";
	const fingerprint = themePaletteFingerprint(theme);
	if (
		_themePaletteCacheTheme === theme &&
		_themePaletteCacheName === themeName &&
		_themePaletteCacheFingerprint === fingerprint
	) {
		applyToolBranchColor(theme);
		syncOutlineChromeFromBranch(theme);
		return;
	}
	const paletteChanged =
		_themePaletteCacheName !== themeName || _themePaletteCacheFingerprint !== fingerprint;
	if (paletteChanged) bumpToolBranchVisualEpoch();
	_themePaletteCacheTheme = theme;
	_themePaletteCacheName = themeName;
	_themePaletteCacheFingerprint = fingerprint;

	const borderMuted = safeFgAnsi(theme, "borderMuted");
	const muted = safeFgAnsi(theme, "muted");
	const dim = safeFgAnsi(theme, "dim") ?? muted;

	// Code fences, thinking/thought text, and ├ ╰ │ all follow branch chrome.
	applyToolBranchColor(theme);

	const chromeFg = BORDER_COLOR;

	// Grouped-tool status counts follow the same semantic theme colors as regular tool dots.
	TOOL_STATUS_SUCCESS = safeFgAnsi(theme, "success") ?? TOOL_STATUS_SUCCESS;
	TOOL_STATUS_ERROR = safeFgAnsi(theme, "error") ?? TOOL_STATUS_ERROR;
	const thinking = safeFgAnsi(theme, "thinkingText");
	TOOL_STATUS_PENDING = dim ?? muted ?? thinking ?? TOOL_STATUS_PENDING;

	// Diff support text colors. These are user-overridable via diffColors.* so
	// we only touch the ones not explicitly set.
	if (!_explicitFgFields.has("fgDim") && muted) FG_DIM = muted;
	if (!_explicitFgFields.has("fgLnum") && muted) FG_LNUM = muted;
	// On light themes the brightened outline can become nearly white, while the
	// old fallback was nearly black. Use the activity-rail gray as a readable
	// light gray; dark themes keep the brighter outline gray. Hatching and rules
	// deliberately share this exact ANSI color.
	const ruleChrome = isLightThemeBackground(theme) ? activityTreeBranchAnsi() : (chromeFg ?? borderMuted);
	if (!_explicitFgFields.has("fgRule") && ruleChrome) FG_RULE = ruleChrome;
	if (!_explicitFgFields.has("fgStripe") && ruleChrome) FG_STRIPE = ruleChrome;
	if (!_explicitFgFields.has("fgSafeMuted") && muted) FG_SAFE_MUTED = muted;

	DIVIDER = `${FG_RULE}│${D_RST}`;

	// Re-trigger background derivation against the new theme unless the user
	// set explicit bg overrides via diffTheme/diffColors.
	if (!hasExplicitBgConfig) {
		autoDeriveBgFromTheme(theme);
		autoDerivePending = false;
	} else if (themeAdaptiveEnabled()) {
		_diffOnLightBg = isLightThemeBackground(theme);
	}
	syncDiffShikiTheme(theme);
}

function applyDiffPalette(): void {
	const config = loadDiffConfig();
	hasExplicitBgConfig = false;
	const preset = config.diffTheme ? DIFF_PRESETS[config.diffTheme] : null;
	if (preset) hasExplicitBgConfig = true;
	const overrides = config.diffColors ?? {};
	if (Object.keys(overrides).length > 0) hasExplicitBgConfig = true;
	_explicitFgFields.clear();

	const applyBg = (key: string, presetValue: string | undefined, set: (value: string) => void) => {
		const hex = overrides[key] ?? presetValue;
		if (!hex) return;
		const ansi = hexToBgAnsi(hex);
		if (ansi) set(ansi);
	};
	const applyFg = (
		key: "fgAdd" | "fgDel" | "fgDim" | "fgLnum" | "fgRule" | "fgStripe" | "fgSafeMuted",
		presetValue: string | undefined,
		set: (value: string) => void,
	) => {
		const hex = overrides[key] ?? presetValue;
		if (!hex) return;
		const ansi = hexToFgAnsi(hex);
		if (!ansi) return;
		set(ansi);
		_explicitFgFields.add(key);
	};

	applyBg("bgAdd", preset?.bgAdd, (v) => {
		BG_ADD = v;
	});
	applyBg("bgDel", preset?.bgDel, (v) => {
		BG_DEL = v;
	});
	applyBg("bgAddHighlight", preset?.bgAddHighlight, (v) => {
		BG_ADD_W = v;
	});
	applyBg("bgDelHighlight", preset?.bgDelHighlight, (v) => {
		BG_DEL_W = v;
	});
	applyBg("bgGutterAdd", preset?.bgGutterAdd, (v) => {
		BG_GUTTER_ADD = v;
	});
	applyBg("bgGutterDel", preset?.bgGutterDel, (v) => {
		BG_GUTTER_DEL = v;
	});
	applyBg("bgEmpty", preset?.bgEmpty, (v) => {
		BG_EMPTY = v;
	});

	applyFg("fgAdd", preset?.fgAdd, (v) => {
		FG_ADD = v;
	});
	applyFg("fgDel", preset?.fgDel, (v) => {
		FG_DEL = v;
	});
	applyFg("fgDim", preset?.fgDim, (v) => {
		FG_DIM = v;
	});
	applyFg("fgLnum", preset?.fgLnum, (v) => {
		FG_LNUM = v;
	});
	applyFg("fgRule", preset?.fgRule, (v) => {
		FG_RULE = v;
	});
	applyFg("fgStripe", preset?.fgStripe, (v) => {
		FG_STRIPE = v;
	});
	applyFg("fgSafeMuted", preset?.fgSafeMuted, (v) => {
		FG_SAFE_MUTED = v;
	});

	const shiki = overrides.shikiTheme ?? preset?.shikiTheme;
	if (shiki) DIFF_THEME = shiki as BundledTheme;

	DIVIDER = `${FG_RULE}│${D_RST}`;
	DEFAULT_DIFF_COLORS = { fgAdd: FG_ADD, fgDel: FG_DEL, fgCtx: FG_DIM };
	// Only trigger auto-derive when the user did NOT supply an explicit
	// preset or per-color override; otherwise we would overwrite their config
	// with the hardcoded dark palette on first render.
	autoDerivePending = !hasExplicitBgConfig;
}

function resolveDiffColors(theme?: any): DiffColors {
	applyThemePaletteIfNeeded(theme);
	if (autoDerivePending && theme?.getFgAnsi) {
		autoDeriveBgFromTheme(theme);
		autoDerivePending = false;
	}
	return DEFAULT_DIFF_COLORS;
}

interface DiffLine {
	type: "add" | "del" | "ctx" | "sep";
	oldNum: number | null;
	newNum: number | null;
	content: string;
}

interface ParsedDiff {
	lines: DiffLine[];
	added: number;
	removed: number;
	chars: number;
}

function diffStrip(value: string): string {
	return value.replace(ANSI_RE, "");
}

function tabs(text: string): string {
	return text.replace(/\t/g, "  ");
}

function termW(): number {
	const raw =
		process.stdout.columns ||
		(process.stderr as any).columns ||
		Number.parseInt(process.env.COLUMNS ?? "", 10) ||
		DEFAULT_TERM_WIDTH;
	return Math.max(40, Math.min(raw - 4, MAX_TERM_WIDTH));
}

// Pi's fullscreen scrollbar owns the final cell. Diff backgrounds must stop one
// column before it or their add/remove tint paints underneath the thumb.
const FULLSCREEN_SCROLLBAR_GUTTER = 1;

function branchDiffWidth(componentWidth?: number, chromeWidth = 0): number {
	// A width that came from the component itself is authoritative: it is the width the row will
	// actually be drawn at, so it is not clamped to the terminal-wide cap. Clamping it there
	// silently wasted dozens of columns on a wide pane — the diff was laid out at MAX_TERM_WIDTH
	// no matter how much room the row had. The cap stays on the environment-derived fallback,
	// where the number is only a guess (termW() applies it itself).
	const known = typeof componentWidth === "number" && Number.isFinite(componentWidth);
	const width = known ? Math.floor(componentWidth) : termW();
	return Math.max(20, width - chromeWidth - FULLSCREEN_SCROLLBAR_GUTTER);
}

function contextDiffWidth(ctx: any, chromeWidth = 0): number {
	return branchDiffWidth(ctx.state?._diffComponentWidth, chromeWidth);
}

function adaptiveWrapRows(tw?: number): number {
	const width = tw ?? termW();
	if (width >= 180) return MAX_WRAP_ROWS_WIDE;
	if (width >= 120) return MAX_WRAP_ROWS_MED;
	return MAX_WRAP_ROWS_NARROW;
}

function fit(value: string, width: number): string {
	if (width <= 0) return "";
	const plain = diffStrip(value);
	if (plain.length <= width) return value + " ".repeat(width - plain.length);
	const showWidth = width > 2 ? width - 1 : width;
	let vis = 0;
	let i = 0;
	while (i < value.length && vis < showWidth) {
		if (value[i] === "\x1b") {
			const end = value.indexOf("m", i);
			if (end !== -1) {
				i = end + 1;
				continue;
			}
		}
		vis++;
		i++;
	}
	return width > 2 ? `${value.slice(0, i)}${D_RST}${FG_DIM}›${D_RST}` : `${value.slice(0, i)}${D_RST}`;
}

function ansiState(text: string): string {
	const matches = text.match(/\x1b\[[0-9;]*m/g) ?? [];
	let fg = "";
	let bg = "";
	for (const seq of matches) {
		const params = seq.slice(2, -1);
		if (params === "0") {
			fg = "";
			bg = "";
		} else if (params === "39") {
			fg = "";
		} else if (params.startsWith("38;")) {
			fg = seq;
		} else if (params.startsWith("48;")) {
			bg = seq;
		}
	}
	return bg + fg;
}

function normalizeShikiContrast(ansi: string): string {
	const darkFgThreshold = _diffOnLightBg ? 140 : 72;
	return ansi.replace(/\x1b\[([0-9;]*)m/g, (seq, params: string) => {
		if (params === "30" || params === "90" || params === "38;5;0" || params === "38;5;8") return FG_SAFE_MUTED;
		if (!params.startsWith("38;2;")) return seq;
		const parts = params.split(";").map(Number);
		if (parts.length !== 5 || parts.some((n) => !Number.isFinite(n))) return seq;
		const [, , r, g, b] = parts;
		const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		if (_diffOnLightBg) {
			return luminance < darkFgThreshold ? seq : FG_SAFE_MUTED;
		}
		return luminance < darkFgThreshold ? FG_SAFE_MUTED : seq;
	});
}

function wrapAnsi(text: string, width: number, maxRows = adaptiveWrapRows(), fillBg = ""): string[] {
	if (width <= 0) return [""];
	const plain = diffStrip(text);
	if (plain.length <= width) {
		const pad = width - plain.length;
		return pad > 0 ? [text + fillBg + " ".repeat(pad) + (fillBg ? D_RST : "")] : [text];
	}

	const rows: string[] = [];
	let row = "";
	let vis = 0;
	let i = 0;
	let onLastRow = false;
	let effectiveWidth = width;

	while (i < text.length) {
		if (!onLastRow && rows.length >= maxRows - 1) {
			onLastRow = true;
			effectiveWidth = width > 2 ? width - 1 : width;
		}
		if (text[i] === "\x1b") {
			const end = text.indexOf("m", i);
			if (end !== -1) {
				row += text.slice(i, end + 1);
				i = end + 1;
				continue;
			}
		}
		if (vis >= effectiveWidth) {
			if (onLastRow) {
				let hasMore = false;
				for (let j = i; j < text.length; j++) {
					if (text[j] === "\x1b") {
						const e2 = text.indexOf("m", j);
						if (e2 !== -1) {
							j = e2;
							continue;
						}
					}
					hasMore = true;
					break;
				}
				if (hasMore && width > 2) row += `${D_RST}${FG_DIM}›${D_RST}`;
				else row += fillBg + " ".repeat(Math.max(0, width - vis)) + D_RST;
				rows.push(row);
				return rows;
			}
			const state = ansiState(row);
			rows.push(row + D_RST);
			row = state + fillBg;
			vis = 0;
			if (rows.length >= maxRows - 1) {
				onLastRow = true;
				effectiveWidth = width > 2 ? width - 1 : width;
			}
		}
		row += text[i];
		vis++;
		i++;
	}

	if (row.length > 0 || rows.length === 0) {
		rows.push(row + fillBg + " ".repeat(Math.max(0, width - vis)) + D_RST);
	}
	return rows;
}

function lnum(n: number | null, width: number, fg = FG_LNUM): string {
	if (n === null) return " ".repeat(width);
	const value = String(n);
	// Callers reset after the whole gutter cell so wrapped rows keep one
	// continuous add/remove background through the line-number/sign columns.
	return `${fg}${" ".repeat(Math.max(0, width - value.length))}${value}`;
}

function stripes(width: number): string {
	// Empty split cells use the same chrome color as borders/dividers so the
	// hatch cannot drift darker or lighter after a theme/config rebind.
	return BG_BASE + FG_RULE + "╱".repeat(width) + D_RST;
}

function renderDiffStatBar(added: number, removed: number, width = termW()): string {
	const total = added + removed;
	if (total === 0 || width < 20) return "";
	const slots = Math.max(8, Math.min(20, Math.floor(width / 14)));
	let addSlots = Math.max(0, Math.min(slots, Math.round((added / total) * slots)));
	if (added > 0 && addSlots === 0) addSlots = 1;
	if (removed > 0 && addSlots >= slots) addSlots = slots - 1;
	const removeSlots = Math.max(0, slots - addSlots);
	const addBar = addSlots > 0 ? `${FG_ADD}${"━".repeat(addSlots)}${D_RST}` : "";
	const removeBar = removeSlots > 0 ? `${FG_DEL}${"━".repeat(removeSlots)}${D_RST}` : "";
	return `${FG_DIM}[${D_RST}${addBar}${removeBar}${FG_DIM}]${D_RST}`;
}

function summarizeDiff(added: number, removed: number): string {
	const parts: string[] = [];
	if (added > 0) parts.push(`${FG_ADD}+${added}${D_RST}`);
	if (removed > 0) parts.push(`${FG_DEL}-${removed}${D_RST}`);
	if (!parts.length) return `${FG_DIM}no changes${D_RST}`;
	const bar = renderDiffStatBar(added, removed);
	return bar ? `${parts.join(" ")} ${bar}` : parts.join(" ");
}

function diffSummaryWithMeta(added: number, removed: number, hunks: number, mode: string): string {
	const base = summarizeDiff(added, removed);
	const extras: string[] = [];
	if (hunks > 0) extras.push(`${FG_DIM}${hunks} hunk${hunks === 1 ? "" : "s"}${D_RST}`);
	if (mode) extras.push(`${FG_DIM}${mode}${D_RST}`);
	return extras.length ? `${base} ${FG_DIM}•${D_RST} ${extras.join(` ${FG_DIM}•${D_RST} `)}` : base;
}

function collapsedDiffHint(remainingLines: number, hiddenHunks: number): string {
	const width = termW();
	const candidates = [
		`… (${remainingLines} more diff lines${hiddenHunks > 0 ? ` • ${hiddenHunks} more hunks` : ""} • ${keyHint("app.tools.expand", "to toggle")})`,
		`… (${remainingLines} more lines${hiddenHunks > 0 ? ` • ${hiddenHunks} hunks` : ""})`,
		`… (+${remainingLines}${hiddenHunks > 0 ? ` • +${hiddenHunks}h` : ""})`,
		"…",
	];
	for (const candidate of candidates) {
		if (visibleWidth(candidate) <= width) return candidate;
	}
	return truncateToWidth("…", width, "");
}

function diffRule(width: number): string {
	return `${BG_BASE}${FG_RULE}${"─".repeat(width)}${D_RST}`;
}

/** Max line number across diff lines. Loop-based (not Math.max(...spread)) so huge
 *  diffs don't blow the call stack with a RangeError. Returns identical results. */
function maxLineNumber(lines: DiffLine[]): number {
	let max = 0;
	for (let i = 0; i < lines.length; i++) {
		const n = lines[i].oldNum ?? lines[i].newNum ?? 0;
		if (n > max) max = n;
	}
	return max;
}

/**
 * Auto diff layout is decided from the diff's *current* content, so a diff that is still
 * streaming can flip between split and unified from one frame to the next — the row count then
 * halves or doubles and the transcript reflows under the reader, which is what made scrolling
 * jump onto whichever edit was streaming. Hold the first decision while the width and the diff
 * stay the same; a resize or a different diff is free to re-decide.
 */
function stickyUseSplit(
	state: any,
	key: string,
	diff: ParsedDiff,
	width: number,
	maxRows: number,
): boolean {
	const prev = state?._diffStickySplit;
	if (prev && prev.key === key && prev.width === width) return prev.split;
	const split = shouldUseSplit(diff, width, maxRows);
	if (state && typeof state === "object") state._diffStickySplit = { key, width, split };
	return split;
}

function shouldUseSplit(diff: ParsedDiff, width: number, maxRows = MAX_PREVIEW_LINES): boolean {
	if (!diff.lines.length) return false;
	const settings = readSettings();
	const configured = resolveDiffPresentationMode(
		{
			diffViewMode: settings.diffViewMode,
			diffSplitMinWidth: settings.diffSplitMinWidth,
		},
		width,
	) === "split";
	if (!configured || settings.diffViewMode === "split") return configured;

	// Medium panes tolerate a two-row source line; genuinely wide panes tolerate
	// three. This keeps full-width terminals in split mode while rejecting the
	// severe multi-row wrapping seen in narrower half-pane layouts.
	const half = Math.floor((width - 1) / 2);
	const numberWidth = Math.max(2, String(maxLineNumber(diff.lines)).length);
	const codeWidth = Math.max(0, half - (numberWidth + 4));
	if (codeWidth < 12) return false;
	const allowedWrapRows = width >= 180 ? MAX_WRAP_ROWS_WIDE : MAX_WRAP_ROWS_MED;
	let seen = 0;
	for (const line of diff.lines) {
		if (line.type === "sep") continue;
		if (seen++ >= maxRows) break;
		const wrapRows = Math.max(1, Math.ceil(visibleWidth(tabs(line.content)) / codeWidth));
		if (wrapRows > allowedWrapRows) return false;
	}
	return true;
}

const EXT_LANG: Record<string, BundledLanguage> = {
	ts: "typescript",
	tsx: "tsx",
	js: "javascript",
	jsx: "jsx",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	rb: "ruby",
	rs: "rust",
	go: "go",
	java: "java",
	c: "c",
	cpp: "cpp",
	h: "c",
	hpp: "cpp",
	cs: "csharp",
	swift: "swift",
	kt: "kotlin",
	html: "html",
	css: "css",
	scss: "scss",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	md: "markdown",
	sql: "sql",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	lua: "lua",
	php: "php",
	dart: "dart",
	xml: "xml",
	graphql: "graphql",
	svelte: "svelte",
	vue: "vue",
};

function lang(filePath: string): BundledLanguage | undefined {
	return EXT_LANG[extname(filePath).slice(1).toLowerCase()];
}

async function codeToAnsiLazy(code: string, language: BundledLanguage, theme: BundledTheme): Promise<string> {
	if (!codeToAnsiLoader) {
		// Self-healing: a failed import (missing dep, transient error) must not leave a
		// permanently-rejected promise that later becomes an unhandled rejection. Reset
		// on failure so the next call retries.
		codeToAnsiLoader = import("@shikijs/cli").then(
			(mod) => mod.codeToANSI,
			(err) => {
				codeToAnsiLoader = null;
				throw err;
			},
		);
	}
	const codeToAnsi = await codeToAnsiLoader;
	return codeToAnsi(code, language, theme);
}

const hlCache = new Map<string, string[]>();

function clearHighlightCache(): void {
	hlCache.clear();
}

function touchCache(key: string, value: string[]): string[] {
	hlCache.delete(key);
	hlCache.set(key, value);
	while (hlCache.size > CACHE_LIMIT) {
		const first = hlCache.keys().next().value;
		if (first === undefined) break;
		hlCache.delete(first);
	}
	return value;
}

/**
 * Highlighting must not change the text it renders.
 *
 * Row layout is decided from line widths, so a highlighted line that is trimmed or wrapped
 * differently from its source (Shiki drops trailing whitespace, and wraps or clips very long
 * lines) shifts every following row: the diff then rows up differently from the unhighlighted
 * fallback and from its own gutters and tint. When the widths disagree, the raw line is kept.
 */
function highlightPreservesSource(rendered: string[], source: string[]): boolean {
	if (rendered.length !== source.length) return false;
	for (let index = 0; index < rendered.length; index++) {
		if (visibleWidth(rendered[index]) !== visibleWidth(source[index])) return false;
	}
	return true;
}

async function hlBlock(code: string, language: BundledLanguage | undefined): Promise<string[]> {
	if (!code) return [""];
	if (!language || code.length > MAX_HL_CHARS) return code.split("\n");
	const key = `${DIFF_THEME}\0${language}\0${code}`;
	const hit = hlCache.get(key);
	if (hit) return touchCache(key, hit);
	try {
		const ansi = normalizeShikiContrast(await codeToAnsiLazy(code, language, DIFF_THEME));
		const out = (ansi.endsWith("\n") ? ansi.slice(0, -1) : ansi).split("\n");
		if (!highlightPreservesSource(out, code.split("\n"))) return code.split("\n");
		return touchCache(key, out);
	} catch {
		return code.split("\n");
	}
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapItem: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const safeLimit = Math.max(1, Math.min(items.length || 1, Math.floor(limit)));
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	await Promise.all(Array.from({ length: safeLimit }, async () => {
		while (true) {
			const index = nextIndex++;
			if (index >= items.length) return;
			results[index] = await mapItem(items[index], index);
		}
	}));
	return results;
}

function parseDiff(oldContent: string, newContent: string, ctxLines = 3): ParsedDiff {
	const patch = Diff.structuredPatch("", "", oldContent, newContent, "", "", { context: ctxLines });
	const lines: DiffLine[] = [];
	let added = 0;
	let removed = 0;
	for (let hi = 0; hi < patch.hunks.length; hi++) {
		if (hi > 0) {
			const prev = patch.hunks[hi - 1];
			const gap = patch.hunks[hi].oldStart - (prev.oldStart + prev.oldLines);
			lines.push({ type: "sep", oldNum: null, newNum: gap > 0 ? gap : null, content: "" });
		}
		const hunk = patch.hunks[hi];
		let oldLine = hunk.oldStart;
		let newLine = hunk.newStart;
		for (const raw of hunk.lines) {
			if (raw === "\\ No newline at end of file") continue;
			const ch = raw[0];
			const text = raw.slice(1);
			if (ch === "+") {
				lines.push({ type: "add", oldNum: null, newNum: newLine++, content: text });
				added++;
			} else if (ch === "-") {
				lines.push({ type: "del", oldNum: oldLine++, newNum: null, content: text });
				removed++;
			} else {
				lines.push({ type: "ctx", oldNum: oldLine++, newNum: newLine++, content: text });
			}
		}
	}
	return { lines, added, removed, chars: oldContent.length + newContent.length };
}

function getCachedParsedDiff(ctx: any, key: string, oldContent: string, newContent: string): ParsedDiff {
	if (ctx.state?._parsedDiffKey === key && ctx.state._parsedDiff) {
		return ctx.state._parsedDiff as ParsedDiff;
	}
	const diff = parseDiff(oldContent, newContent);
	if (ctx.state) {
		ctx.state._parsedDiffKey = key;
		ctx.state._parsedDiff = diff;
	}
	return diff;
}

function wordDiffAnalysis(
	oldText: string,
	newText: string,
): { similarity: number; oldRanges: Array<[number, number]>; newRanges: Array<[number, number]> } {
	if (!oldText && !newText) return { similarity: 1, oldRanges: [], newRanges: [] };
	const parts = Diff.diffWords(oldText, newText);
	const oldRanges: Array<[number, number]> = [];
	const newRanges: Array<[number, number]> = [];
	let oldPos = 0;
	let newPos = 0;
	let same = 0;
	for (const part of parts) {
		if (part.removed) {
			oldRanges.push([oldPos, oldPos + part.value.length]);
			oldPos += part.value.length;
		} else if (part.added) {
			newRanges.push([newPos, newPos + part.value.length]);
			newPos += part.value.length;
		} else {
			const len = part.value.length;
			same += len;
			oldPos += len;
			newPos += len;
		}
	}
	const maxLen = Math.max(oldText.length, newText.length);
	return { similarity: maxLen > 0 ? same / maxLen : 1, oldRanges, newRanges };
}

function injectBg(ansiLine: string, ranges: Array<[number, number]>, baseBg: string, hlBg: string): string {
	if (!ranges.length) return baseBg + ansiLine + D_RST;
	let out = baseBg;
	let vis = 0;
	let inHL = false;
	let rangeIndex = 0;
	let i = 0;
	while (i < ansiLine.length) {
		if (ansiLine[i] === "\x1b") {
			const end = ansiLine.indexOf("m", i);
			if (end !== -1) {
				const seq = ansiLine.slice(i, end + 1);
				out += seq;
				if (seq === "\x1b[0m") out += inHL ? hlBg : baseBg;
				i = end + 1;
				continue;
			}
		}
		while (rangeIndex < ranges.length && vis >= ranges[rangeIndex][1]) rangeIndex++;
		const want = rangeIndex < ranges.length && vis >= ranges[rangeIndex][0] && vis < ranges[rangeIndex][1];
		if (want !== inHL) {
			inHL = want;
			out += inHL ? hlBg : baseBg;
		}
		out += ansiLine[i];
		vis++;
		i++;
	}
	return out + D_RST;
}

function plainWordDiff(oldText: string, newText: string): { old: string; new: string } {
	const parts = Diff.diffWords(oldText, newText);
	let oldOut = "";
	let newOut = "";
	for (const part of parts) {
		if (part.removed) oldOut += `${BG_DEL_W}${part.value}${D_RST}${BG_DEL}`;
		else if (part.added) newOut += `${BG_ADD_W}${part.value}${D_RST}${BG_ADD}`;
		else {
			oldOut += part.value;
			newOut += part.value;
		}
	}
	return { old: oldOut, new: newOut };
}

/** Source lines the highlighter needs for each side of a unified diff. */
function unifiedHighlightSources(vis: DiffLine[]): { oldSrc: string[]; newSrc: string[] } {
	const oldSrc: string[] = [];
	const newSrc: string[] = [];
	for (const line of vis) {
		if (line.type === "ctx" || line.type === "del") oldSrc.push(line.content);
		if (line.type === "ctx" || line.type === "add") newSrc.push(line.content);
	}
	return { oldSrc, newSrc };
}

/** Highlighting is capped by size; above the caps the raw text is rendered as-is. */
function canHighlightDiff(diff: ParsedDiff, vis: DiffLine[]): boolean {
	return diff.chars <= MAX_HL_CHARS && vis.length <= MAX_RENDER_LINES;
}

/**
 * Rows for a unified diff.
 *
 * Highlighting lives in the callers so the same diff can also be rendered *without* it. Shiki is
 * asynchronous, and a fallback body whose height differs from the highlighted one reflows the
 * transcript under the reader (the scrolling jump), so the unhighlighted render goes through
 * this exact function with the raw source lines: every row, wrap, gutter and hint is identical
 * and only the colors differ. `emphasize` is the same size-cap decision for both renders, so
 * the word-level diff branch takes the same path in each.
 */
function renderUnifiedRows(
	diff: ParsedDiff,
	vis: DiffLine[],
	width: number,
	dc: DiffColors,
	oldHL: string[],
	newHL: string[],
	emphasize: boolean,
): string {
	const tw = width;
	const nw = Math.max(2, String(maxLineNumber(vis)).length);
	const gw = nw + 4;
	const cw = Math.max(20, tw - gw);

	let oldIndex = 0;
	let newIndex = 0;
	let index = 0;
	const out: string[] = [diffRule(tw)];

	function emitRow(num: number | null, sign: string, gutterBg: string, body: string, bodyBg = ""): void {
		const borderFg = sign === "-" ? dc.fgDel : sign === "+" ? dc.fgAdd : "";
		const border = borderFg ? `${borderFg}▌${D_RST}` : `${BG_BASE} `;
		const numFg = borderFg || FG_LNUM;
		// Add/remove state is carried by color and the edge bar; omitting the
		// redundant +/- marker recovers one source-code column.
		const gutter = `${border}${gutterBg}${lnum(num, nw, numFg)} ${D_RST}${DIVIDER} `;
		const cont = `${border}${gutterBg}${" ".repeat(nw + 1)}${D_RST}${DIVIDER} `;
		const rows = wrapAnsi(tabs(body), cw, adaptiveWrapRows(), bodyBg);
		out.push(`${gutter}${rows[0]}${D_RST}`);
		for (let r = 1; r < rows.length; r++) out.push(`${cont}${rows[r]}${D_RST}`);
	}

	while (index < vis.length) {
		const line = vis[index];
		if (line.type === "sep") {
			const gap = line.newNum;
			const label = gap && gap > 0 ? ` ${gap} unmodified lines ` : "···";
			const totalW = Math.min(tw, 72);
			const pad = Math.max(0, totalW - label.length - 2);
			const half1 = Math.floor(pad / 2);
			const half2 = pad - half1;
			out.push(`${BG_BASE}${FG_DIM}${"─".repeat(half1)}${label}${"─".repeat(half2)}${D_RST}`);
			index++;
			continue;
		}
		if (line.type === "ctx") {
			const hl = oldHL[oldIndex] ?? line.content;
			emitRow(line.newNum, " ", BG_BASE, `${BG_BASE}${D_DIM}${hl}`, BG_BASE);
			oldIndex++;
			newIndex++;
			index++;
			continue;
		}

		const dels: Array<{ l: DiffLine; hl: string }> = [];
		while (index < vis.length && vis[index].type === "del") {
			dels.push({ l: vis[index], hl: oldHL[oldIndex] ?? vis[index].content });
			oldIndex++;
			index++;
		}
		const adds: Array<{ l: DiffLine; hl: string }> = [];
		while (index < vis.length && vis[index].type === "add") {
			adds.push({ l: vis[index], hl: newHL[newIndex] ?? vis[index].content });
			newIndex++;
			index++;
		}

		const isPaired = dels.length === 1 && adds.length === 1;
		const wd = isPaired ? wordDiffAnalysis(dels[0].l.content, adds[0].l.content) : null;
		if (isPaired && wd && wd.similarity >= WORD_DIFF_MIN_SIM && emphasize) {
			emitRow(dels[0].l.oldNum, "-", BG_GUTTER_DEL, injectBg(dels[0].hl, wd.oldRanges, BG_DEL, BG_DEL_W), BG_DEL);
			emitRow(adds[0].l.newNum, "+", BG_GUTTER_ADD, injectBg(adds[0].hl, wd.newRanges, BG_ADD, BG_ADD_W), BG_ADD);
			continue;
		}
		if (isPaired && wd && wd.similarity >= WORD_DIFF_MIN_SIM && !emphasize) {
			const pwd = plainWordDiff(dels[0].l.content, adds[0].l.content);
			emitRow(dels[0].l.oldNum, "-", BG_GUTTER_DEL, `${BG_DEL}${pwd.old}`, BG_DEL);
			emitRow(adds[0].l.newNum, "+", BG_GUTTER_ADD, `${BG_ADD}${pwd.new}`, BG_ADD);
			continue;
		}
		for (const d of dels) emitRow(d.l.oldNum, "-", BG_GUTTER_DEL, `${BG_DEL}${emphasize ? d.hl : d.l.content}`, BG_DEL);
		for (const a of adds) emitRow(a.l.newNum, "+", BG_GUTTER_ADD, `${BG_ADD}${emphasize ? a.hl : a.l.content}`, BG_ADD);
	}

	out.push(diffRule(tw));
	if (diff.lines.length > vis.length) out.push(`${BG_BASE}${FG_DIM}  ${collapsedDiffHint(diff.lines.length - vis.length, 0)}${D_RST}`);
	return out.join("\n");
}

async function renderUnified(
	diff: ParsedDiff,
	language: BundledLanguage | undefined,
	max = MAX_RENDER_LINES,
	dc: DiffColors = DEFAULT_DIFF_COLORS,
	width = termW(),
): Promise<string> {
	if (!diff.lines.length) return "";
	const vis = diff.lines.slice(0, max);
	const { oldSrc, newSrc } = unifiedHighlightSources(vis);
	const canHL = canHighlightDiff(diff, vis);
	const [oldHL, newHL] = canHL
		? await Promise.all([hlBlock(oldSrc.join("\n"), language), hlBlock(newSrc.join("\n"), language)])
		: [oldSrc, newSrc];
	return renderUnifiedRows(diff, vis, width, dc, oldHL, newHL, canHL);
}

/**
 * The same unified diff with no syntax highlighting, rendered synchronously so a row can take
 * its final height on the first frame instead of waiting one behind Shiki (and instead of a
 * short placeholder that reflows the transcript when the highlighted body replaces it).
 */
function renderUnifiedPlain(
	diff: ParsedDiff,
	max = MAX_RENDER_LINES,
	dc: DiffColors = DEFAULT_DIFF_COLORS,
	width = termW(),
): string {
	if (!diff.lines.length) return "";
	const vis = diff.lines.slice(0, max);
	const { oldSrc, newSrc } = unifiedHighlightSources(vis);
	return renderUnifiedRows(diff, vis, width, dc, oldSrc, newSrc, canHighlightDiff(diff, vis));
}

type SplitRow = { left: DiffLine | null; right: DiffLine | null };

/** Pair deleted/added lines into the two columns a split diff draws. */
function buildSplitRows(lines: DiffLine[]): SplitRow[] {
	const rows: SplitRow[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.type === "sep" || line.type === "ctx") {
			rows.push({ left: line, right: line });
			i++;
			continue;
		}
		const dels: DiffLine[] = [];
		const adds: DiffLine[] = [];
		while (i < lines.length && lines[i].type === "del") dels.push(lines[i++]);
		while (i < lines.length && lines[i].type === "add") adds.push(lines[i++]);
		const n = Math.max(dels.length, adds.length);
		for (let j = 0; j < n; j++) rows.push({ left: dels[j] ?? null, right: adds[j] ?? null });
	}
	return rows;
}

/** Source lines the highlighter needs for each column of a split diff. */
function splitHighlightSources(vis: SplitRow[]): { leftSrc: string[]; rightSrc: string[] } {
	const leftSrc: string[] = [];
	const rightSrc: string[] = [];
	for (const row of vis) {
		if (row.left && row.left.type !== "sep") leftSrc.push(row.left.content);
		if (row.right && row.right.type !== "sep") rightSrc.push(row.right.content);
	}
	return { leftSrc, rightSrc };
}

/**
 * Rows for a two-column diff. Like `renderUnifiedRows`, highlighting is done by the callers so
 * an unhighlighted render can go through this same code path: identical rows and height, only
 * the colors differ (see the note there).
 */
function renderSplitRows(
	diff: ParsedDiff,
	vis: SplitRow[],
	allRows: SplitRow[],
	width: number,
	dc: DiffColors,
	leftHL: string[],
	rightHL: string[],
	emphasize: boolean,
): string {
	const tw = width;
	const half = Math.floor((tw - 1) / 2);
	const nw = Math.max(2, String(maxLineNumber(diff.lines)).length);
	const gw = nw + 4;
	const cw = Math.max(12, half - gw);

	let leftIndex = 0;
	let rightIndex = 0;

	type HalfResult = { gutter: string; contGutter: string; bodyRows: string[] };
	function halfBuild(
		line: DiffLine | null,
		hl: string,
		ranges: Array<[number, number]> | null,
		side: "left" | "right",
	): HalfResult {
		if (!line) {
			const gPat = FG_RULE + "╱".repeat(nw + 1) + D_RST;
			const gutter = ` ${gPat}${FG_RULE}│${D_RST} `;
			return { gutter, contGutter: gutter, bodyRows: [stripes(cw)] };
		}
		if (line.type === "sep") {
			const gap = line.newNum;
			const label = gap && gap > 0 ? `··· ${gap} lines ···` : "···";
			const gutter = `${BG_BASE} ${FG_DIM}${fit("", nw + 1)}${D_RST}${FG_RULE}│${D_RST} `;
			return { gutter, contGutter: gutter, bodyRows: [`${BG_BASE}${FG_DIM}${fit(label, cw)}${D_RST}`] };
		}
		const isDel = line.type === "del";
		const isAdd = line.type === "add";
		const gBg = isDel ? BG_GUTTER_DEL : isAdd ? BG_GUTTER_ADD : BG_BASE;
		const cBg = isDel ? BG_DEL : isAdd ? BG_ADD : BG_BASE;
		const num = isDel ? line.oldNum : isAdd ? line.newNum : side === "left" ? line.oldNum : line.newNum;
		const borderFg = isDel ? dc.fgDel : isAdd ? dc.fgAdd : "";
		const border = borderFg ? `${borderFg}▌${D_RST}` : ` ${BG_BASE}`;
		const numFg = borderFg || FG_LNUM;
		let body: string;
		if (ranges && ranges.length > 0) body = injectBg(hl, ranges, cBg, isDel ? BG_DEL_W : BG_ADD_W);
		else if (isDel || isAdd) body = `${cBg}${hl}`;
		else body = `${BG_BASE}${D_DIM}${hl}`;
		const gutter = `${border}${gBg}${lnum(num, nw, numFg)} ${D_RST}${FG_RULE}│${D_RST} `;
		const contGutter = `${border}${gBg}${" ".repeat(nw + 1)}${D_RST}${FG_RULE}│${D_RST} `;
		return { gutter, contGutter, bodyRows: wrapAnsi(tabs(body), cw, adaptiveWrapRows(), cBg) };
	}

	const out: string[] = [];
	out.push(`${diffRule(half)}${FG_RULE}┊${D_RST}${diffRule(half)}`);

	for (const row of vis) {
		const leftLine = row.left;
		const rightLine = row.right;
		const paired = Boolean(leftLine && rightLine && leftLine.type === "del" && rightLine.type === "add");
		const wd = paired && leftLine && rightLine ? wordDiffAnalysis(leftLine.content, rightLine.content) : null;
		let leftResult: HalfResult;
		let rightResult: HalfResult;
		if (paired && wd && leftLine && rightLine && wd.similarity >= WORD_DIFF_MIN_SIM && emphasize) {
			leftResult = halfBuild(leftLine, leftHL[leftIndex++] ?? leftLine.content, wd.oldRanges, "left");
			rightResult = halfBuild(rightLine, rightHL[rightIndex++] ?? rightLine.content, wd.newRanges, "right");
		} else if (paired && wd && leftLine && rightLine && wd.similarity >= WORD_DIFF_MIN_SIM && !emphasize) {
			const pwd = plainWordDiff(leftLine.content, rightLine.content);
			leftIndex++;
			rightIndex++;
			leftResult = halfBuild(leftLine, pwd.old, null, "left");
			rightResult = halfBuild(rightLine, pwd.new, null, "right");
		} else {
			leftResult = halfBuild(
				row.left,
				row.left && row.left.type !== "sep" ? (leftHL[leftIndex++] ?? row.left.content) : "",
				null,
				"left",
			);
			rightResult = halfBuild(
				row.right,
				row.right && row.right.type !== "sep" ? (rightHL[rightIndex++] ?? row.right.content) : "",
				null,
				"right",
			);
		}
		const maxRows = Math.max(leftResult.bodyRows.length, rightResult.bodyRows.length);
		for (let rowIndex = 0; rowIndex < maxRows; rowIndex++) {
			const lg = rowIndex === 0 ? leftResult.gutter : leftResult.contGutter;
			const rg = rowIndex === 0 ? rightResult.gutter : rightResult.contGutter;
			const lb = leftResult.bodyRows[rowIndex] ?? (!row.left ? stripes(cw) : `${BG_EMPTY}${" ".repeat(cw)}${D_RST}`);
			const rb = rightResult.bodyRows[rowIndex] ?? (!row.right ? stripes(cw) : `${BG_EMPTY}${" ".repeat(cw)}${D_RST}`);
			out.push(`${lg}${lb}${DIVIDER}${rg}${rb}`);
		}
	}

	out.push(`${diffRule(half)}${FG_RULE}┊${D_RST}${diffRule(half)}`);
	if (allRows.length > vis.length) out.push(`${BG_BASE}${FG_DIM}  ${collapsedDiffHint(allRows.length - vis.length, 0)}${D_RST}`);
	return out.join("\n");
}

async function renderSplit(
	diff: ParsedDiff,
	language: BundledLanguage | undefined,
	max = MAX_PREVIEW_LINES,
	dc: DiffColors = DEFAULT_DIFF_COLORS,
	width = termW(),
): Promise<string> {
	if (!shouldUseSplit(diff, width, max)) return renderUnified(diff, language, max, dc, width);
	if (!diff.lines.length) return "";
	const allRows = buildSplitRows(diff.lines);
	const vis = allRows.slice(0, max);
	const { leftSrc, rightSrc } = splitHighlightSources(vis);
	const canHL = canHighlightDiff(diff, vis);
	const [leftHL, rightHL] = canHL
		? await Promise.all([hlBlock(leftSrc.join("\n"), language), hlBlock(rightSrc.join("\n"), language)])
		: [leftSrc, rightSrc];
	return renderSplitRows(diff, vis, allRows, width, dc, leftHL, rightHL, canHL);
}

/**
 * The same split diff with no syntax highlighting, rendered synchronously: identical rows and
 * height to the highlighted body, so replacing one with the other cannot reflow the transcript.
 */
function renderSplitPlain(
	diff: ParsedDiff,
	max = MAX_PREVIEW_LINES,
	dc: DiffColors = DEFAULT_DIFF_COLORS,
	width = termW(),
): string {
	if (!shouldUseSplit(diff, width, max)) return renderUnifiedPlain(diff, max, dc, width);
	if (!diff.lines.length) return "";
	const allRows = buildSplitRows(diff.lines);
	const vis = allRows.slice(0, max);
	const { leftSrc, rightSrc } = splitHighlightSources(vis);
	return renderSplitRows(diff, vis, allRows, width, dc, leftSrc, rightSrc, canHighlightDiff(diff, vis));
}

function getEditOperations(input: any): Array<{ oldText: string; newText: string }> {
	if (Array.isArray(input?.edits)) {
		return input.edits
			.map((edit: any) => ({
				oldText: typeof edit?.oldText === "string" ? edit.oldText : typeof edit?.old_text === "string" ? edit.old_text : "",
				newText: typeof edit?.newText === "string" ? edit.newText : typeof edit?.new_text === "string" ? edit.new_text : "",
			}))
			.filter((edit: { oldText: string; newText: string }) => edit.oldText && edit.oldText !== edit.newText);
	}
	const oldText = typeof input?.oldText === "string" ? input.oldText : typeof input?.old_text === "string" ? input.old_text : "";
	const newText = typeof input?.newText === "string" ? input.newText : typeof input?.new_text === "string" ? input.new_text : "";
	return oldText && oldText !== newText ? [{ oldText, newText }] : [];
}

function summarizeEditOperations(operations: Array<{ oldText: string; newText: string }>) {
	const diffs = operations.map((edit) => parseDiff(edit.oldText, edit.newText));
	const totalAdded = diffs.reduce((sum, diff) => sum + diff.added, 0);
	const totalRemoved = diffs.reduce((sum, diff) => sum + diff.removed, 0);
	const totalLines = diffs.reduce((sum, diff) => sum + diff.lines.length, 0);
	const totalHunks = diffs.reduce((sum, diff) => sum + diff.lines.filter((l) => l.type === "sep").length + (diff.lines.length ? 1 : 0), 0);
	return { diffs, totalAdded, totalRemoved, totalLines, totalHunks, summary: summarizeDiff(totalAdded, totalRemoved) };
}

type EditOperationSummary = ReturnType<typeof summarizeEditOperations>;

function getCachedEditOperationSummary(ctx: any, key: string, operations: Array<{ oldText: string; newText: string }>): EditOperationSummary {
	if (ctx.state?._editSummaryKey === key && ctx.state._editSummary) {
		return ctx.state._editSummary as EditOperationSummary;
	}
	const summary = summarizeEditOperations(operations);
	if (ctx.state) {
		ctx.state._editSummaryKey = key;
		ctx.state._editSummary = summary;
	}
	return summary;
}

function normalizeToLf(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripBomText(text: string): string {
	return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function normalizeTextForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function findEditMatch(content: string, oldText: string): { found: boolean; index: number; matchLength: number; usedFuzzyMatch: boolean } {
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false };
	const fuzzyContent = normalizeTextForFuzzyMatch(content);
	const fuzzyOldText = normalizeTextForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
	return fuzzyIndex === -1
		? { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false }
		: { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, usedFuzzyMatch: true };
}

function countFuzzyOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeTextForFuzzyMatch(content);
	const fuzzyOldText = normalizeTextForFuzzyMatch(oldText);
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

function lineNumberAtIndex(text: string, index: number): number {
	return text.slice(0, Math.max(0, index)).split("\n").length;
}

function countLineBreaks(text: string): number {
	return (text.match(/\n/g) ?? []).length;
}

function offsetParsedDiff(diff: ParsedDiff, oldOffset: number, newOffset = oldOffset): ParsedDiff {
	return {
		...diff,
		lines: diff.lines.map((line) =>
			line.type === "sep"
				? line
				: {
					...line,
					oldNum: line.oldNum === null ? null : line.oldNum + oldOffset,
					newNum: line.newNum === null ? null : line.newNum + newOffset,
				},
		),
	};
}

function getFirstChangedNewLine(diff: ParsedDiff): number {
	let currentNewLine = 0;
	for (let i = 0; i < diff.lines.length; i++) {
		const line = diff.lines[i];
		if (line.type === "sep") {
			currentNewLine = 0;
			continue;
		}
		if (line.type === "ctx") {
			currentNewLine = (line.newNum ?? currentNewLine) + 1;
			continue;
		}
		if (line.type === "add") return line.newNum ?? currentNewLine;
		if (currentNewLine > 0) return currentNewLine;
		const next = diff.lines.slice(i + 1).find((entry) => entry.type !== "sep" && entry.newNum !== null);
		if (next && next.newNum !== null) return next.newNum;
		return line.oldNum ?? 0;
	}
	return 0;
}

interface LocalizedEditDiff {
	diff: ParsedDiff;
	line: number;
}

/** Shared projection logic; the callers supply the file contents (see the note on the wrappers). */
function projectEditDiff(
	operations: Array<{ oldText: string; newText: string }>,
	rawContent: string,
): ParsedDiff | null {
	const normalizedContent = normalizeToLf(stripBomText(rawContent));
	const normalizedOps = operations.map((edit) => ({
		oldText: normalizeToLf(edit.oldText),
		newText: normalizeToLf(edit.newText),
	}));
	const baseContent = normalizedOps.some((edit) => findEditMatch(normalizedContent, edit.oldText).usedFuzzyMatch)
		? normalizeTextForFuzzyMatch(normalizedContent)
		: normalizedContent;
	const matches = normalizedOps.map((edit) => {
		const match = findEditMatch(baseContent, edit.oldText);
		if (!match.found || countFuzzyOccurrences(baseContent, edit.oldText) !== 1) return null;
		return { matchIndex: match.index, matchLength: match.matchLength, newText: edit.newText };
	});
	if (matches.some((match) => match === null)) return null;
	const ordered = [...(matches as Array<{ matchIndex: number; matchLength: number; newText: string }>)]
		.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let index = 1; index < ordered.length; index++) {
		const previous = ordered[index - 1];
		const current = ordered[index];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) return null;
	}
	let projected = baseContent;
	for (let index = ordered.length - 1; index >= 0; index--) {
		const match = ordered[index];
		projected = `${projected.slice(0, match.matchIndex)}${match.newText}${projected.slice(match.matchIndex + match.matchLength)}`;
	}
	return parseDiff(baseContent, projected);
}

async function computeProjectedEditDiff(filePath: string, operations: Array<{ oldText: string; newText: string }>, cwd: string): Promise<ParsedDiff | null> {
	if (!filePath || operations.length === 0) return null;
	try {
		return projectEditDiff(operations, await readFileAsync(resolve(cwd, filePath), "utf8"));
	} catch {
		return null;
	}
}

/**
 * Same projection, read synchronously.
 *
 * The renderer needs the diff *on this frame* to draw a body whose height already matches the
 * highlighted one; the asynchronous read otherwise forces a short placeholder frame first, and
 * the row shrinking and growing again is what reflows the transcript while the reader scrolls.
 */
function computeProjectedEditDiffSync(filePath: string, operations: Array<{ oldText: string; newText: string }>, cwd: string): ParsedDiff | null {
	if (!filePath || operations.length === 0) return null;
	try {
		return projectEditDiff(operations, readFileSync(resolve(cwd, filePath), "utf8"));
	} catch {
		return null;
	}
}

async function computeLocalizedEditDiffs(filePath: string, operations: Array<{ oldText: string; newText: string }>, cwd: string): Promise<LocalizedEditDiff[] | null> {
	if (!filePath || operations.length === 0) return null;
	try {
		const rawContent = await readFileAsync(resolve(cwd, filePath), "utf8");
		const normalizedContent = normalizeToLf(stripBomText(rawContent));
		const normalizedOps = operations.map((edit) => ({ oldText: normalizeToLf(edit.oldText), newText: normalizeToLf(edit.newText) }));
		const baseContent = normalizedOps.some((edit) => findEditMatch(normalizedContent, edit.oldText).usedFuzzyMatch)
			? normalizeTextForFuzzyMatch(normalizedContent)
			: normalizedContent;
		const matches = normalizedOps.map((edit, editIndex) => {
			const match = findEditMatch(baseContent, edit.oldText);
			if (!match.found || countFuzzyOccurrences(baseContent, edit.oldText) !== 1) return null;
			return { editIndex, matchIndex: match.index, matchLength: match.matchLength, newText: edit.newText };
		});
		if (matches.some((match) => match === null)) return null;
		const ordered = [...(matches as Array<{ editIndex: number; matchIndex: number; matchLength: number; newText: string }>)].sort((a, b) => a.matchIndex - b.matchIndex);
		for (let i = 1; i < ordered.length; i++) {
			const prev = ordered[i - 1];
			const current = ordered[i];
			if (prev.matchIndex + prev.matchLength > current.matchIndex) return null;
		}
		const localized: Array<LocalizedEditDiff | null> = Array(operations.length).fill(null);
		let lineDelta = 0;
		for (const match of ordered) {
			const oldChunk = baseContent.slice(match.matchIndex, match.matchIndex + match.matchLength);
			const oldStartLine = lineNumberAtIndex(baseContent, match.matchIndex);
			const newStartLine = oldStartLine + lineDelta;
			const diff = offsetParsedDiff(parseDiff(oldChunk, match.newText), oldStartLine - 1, newStartLine - 1);
			localized[match.editIndex] = { diff, line: getFirstChangedNewLine(diff) };
			lineDelta += countLineBreaks(match.newText) - countLineBreaks(oldChunk);
		}
		return localized.every(Boolean) ? (localized as LocalizedEditDiff[]) : null;
	} catch {
		return null;
	}
}

/** Number of terminal rows a rendered diff body occupies. */
function diffBodyRowCount(body: string): number {
	return body.split("\n").length;
}

/**
 * Highlighted body for a diff, but only when it occupies exactly as many rows as the plain one.
 *
 * `wrapAnsi` re-slices text that carries ANSI colors, so a highlighted line can fit fewer
 * characters per row than the same plain line and wrap into more rows (Shiki long lines do this).
 * Swapping that body in changes the row's height, which reflows the transcript under the reader —
 * the scrolling jump this whole path avoids — and it also desynchronises the body from its gutters
 * and tint. The plain body is already on screen, so preferring it costs only the colors.
 */
async function renderDiffBody(
	plainBody: string,
	diff: ParsedDiff,
	language: BundledLanguage | undefined,
	max: number,
	dc: DiffColors,
	width: number,
	mode: "split" | "unified",
): Promise<string> {
	const highlighted = mode === "split"
		? await renderSplit(diff, language, max, dc, width)
		: await renderUnified(diff, language, max, dc, width);
	return diffBodyRowCount(highlighted) === diffBodyRowCount(plainBody) ? highlighted : plainBody;
}

function renderPendingWritePreviewBody(
	ctx: any,
	key: string,
	theme: Theme,
	filePath: string,
	previousContent: string,
	nextContent: string,
	existedBefore: boolean,
): void {
	const diff = getCachedParsedDiff(ctx, `pending-write-diff:${key}`, previousContent, nextContent);
	const hunks = countDiffHunks(diff);
	const diffWidth = contextDiffWidth(ctx);
	const previewLines = ctx.expanded ? MAX_RENDER_LINES : diffCollapsedLimit();
	const mode = existedBefore && stickyUseSplit(ctx.state, `pending-write:${key}`, diff, diffWidth, previewLines) ? "split" : "unified";
	const summary = diffSummaryWithMeta(diff.added, diff.removed, hunks, mode);
	const action = theme.fg("muted", existedBefore ? "pending overwrite" : "pending create");
	const dc = resolveDiffColors(theme);
	// Synchronous, unhighlighted first: the highlighted pass below changes only colors, so the row
	// takes its final height immediately instead of showing a shorter body while Shiki loads.
	const renderPlain = mode === "split" ? renderSplitPlain : renderUnifiedPlain;
	const plainBody = renderPlain(diff, previewLines, dc, diffWidth);
	ctx.state._pendingWritePreviewBody = `${action} ${summary}\n${plainBody}`;
	ctx.state._pendingWritePreviewDisplay = indentBranchBlock(withBranch(ctx.state._pendingWritePreviewBody, theme, false, true));
	renderDiffBody(plainBody, diff, lang(filePath), previewLines, dc, diffWidth, mode)
		.then((rendered) => {
			if (ctx.state._pendingWritePreviewKey !== key) return;
			ctx.state._pendingWritePreviewBody = `${action} ${summary}\n${rendered}`;
			ctx.state._pendingWritePreviewDisplay = indentBranchBlock(withBranch(ctx.state._pendingWritePreviewBody, theme, false, true));
			safeInvalidate(ctx);
		})
		.catch(() => {
			if (ctx.state._pendingWritePreviewKey !== key) return;
			// Keep any preview that is already on screen: the action line alone shrinks the row.
			if (!ctx.state._pendingWritePreviewDisplay) {
				ctx.state._pendingWritePreviewBody = `${action} ${summary}`;
				ctx.state._pendingWritePreviewDisplay = indentBranchBlock(withBranch(ctx.state._pendingWritePreviewBody, theme, false, true));
			}
			safeInvalidate(ctx);
		});
}

function renderProjectedEditPreviewBody(
	ctx: any,
	key: string,
	theme: Theme,
	language: BundledLanguage | undefined,
	diff: ParsedDiff,
): void {
	const diffWidth = contextDiffWidth(ctx);
	// File mutations are intentionally not reduced to a stat line in the activity
	// tree. Keep every hunk (with structuredPatch's three context lines) up to the
	// normal safety cap; Ctrl+O remains available for exceptionally large diffs.
	const previewLines = ctx.expanded
		? MAX_RENDER_LINES
		: Math.min(MAX_RENDER_LINES, Math.max(diffCollapsedLimit(), diff.lines.length));
	const hunks = countDiffHunks(diff);
	const mode = stickyUseSplit(ctx.state, `projected-edit:${key}`, diff, diffWidth, previewLines) ? "split" : "unified";
	const summary = diffSummaryWithMeta(diff.added, diff.removed, hunks, mode);
	const dc = resolveDiffColors(theme);
	// Synchronous, unhighlighted first: the highlighted pass below changes only colors, so the row
	// takes its final height immediately instead of showing a shorter body while Shiki loads.
	const renderPlain = mode === "split" ? renderSplitPlain : renderUnifiedPlain;
	const plainBody = renderPlain(diff, previewLines, dc, diffWidth);
	ctx.state._ptBody = `${summary}\n${plainBody}`;
	ctx.state._ptDisplay = indentBranchBlock(withBranch(ctx.state._ptBody, theme, false, true));
	renderDiffBody(plainBody, diff, language, previewLines, dc, diffWidth, mode)
		.then((rendered) => {
			if (ctx.state._pk !== key) return;
			ctx.state._ptBody = `${summary}\n${rendered}`;
			ctx.state._ptDisplay = indentBranchBlock(withBranch(ctx.state._ptBody, theme, false, true));
			safeInvalidate(ctx);
		})
		.catch(() => {
			if (ctx.state._pk !== key) return;
			// Keep any diff that is already on screen: the summary line alone shrinks the row.
			if (!ctx.state._ptDisplay) {
				ctx.state._ptBody = summary;
				ctx.state._ptDisplay = indentBranchBlock(withBranch(summary, theme, false, true));
			}
			safeInvalidate(ctx);
		});
}

function joinEditDiffSections(sections: string[]): string {
	return sections.map((section, index) => {
		if (index === 0) return section;
		const lines = section.split("\n");
		// Each renderer frames its block. Drop only the next block's opening rule,
		// leaving the previous closing rule as the single divider between edits.
		if (lines.length > 1 && /^[─┊]+$/.test(diffStrip(lines[0]))) lines.shift();
		return lines.join("\n");
	}).join("\n");
}

function renderEditPreviewBody(
	ctx: any,
	key: string,
	theme: Theme,
	language: BundledLanguage | undefined,
	operations: Array<{ oldText: string; newText: string }>,
	diffs: ParsedDiff[],
	summary: string,
): void {
	const dc = resolveDiffColors(theme);
	const branchWidth = contextDiffWidth(ctx);
	if (operations.length === 1) {
		const [diff] = diffs;
		// Synchronous, unhighlighted first: same rows and height as the highlighted pass below, so
		// the row is complete on this frame instead of short while Shiki loads (see renderUnifiedRows).
		const previewLineCap = ctx.expanded ? MAX_PREVIEW_LINES : 32;
		const plainBody = renderSplitPlain(diff, previewLineCap, dc, branchWidth);
		ctx.state._ptBody = `${summarizeDiff(diff.added, diff.removed)}\n${plainBody}`;
		ctx.state._ptDisplay = indentBranchBlock(withBranch(ctx.state._ptBody, theme, false, true));
		renderDiffBody(plainBody, diff, language, previewLineCap, dc, branchWidth, "split")
			.then((rendered) => {
				if (ctx.state._pk !== key) return;
				ctx.state._ptBody = `${summarizeDiff(diff.added, diff.removed)}\n${rendered}`;
				ctx.state._ptDisplay = indentBranchBlock(withBranch(ctx.state._ptBody, theme, false, true));
				safeInvalidate(ctx);
			})
			.catch(() => {
				if (ctx.state._pk !== key) return;
				// Keep any diff that is already on screen: the summary line alone shrinks the row.
				if (!ctx.state._ptDisplay) {
					ctx.state._ptBody = summarizeDiff(diff.added, diff.removed);
					ctx.state._ptDisplay = indentBranchBlock(withBranch(ctx.state._ptBody, theme, false, true));
				}
				safeInvalidate(ctx);
			});
		return;
	}
	const maxShown = operations.length;
	const previewLines = Math.max(8, Math.floor(MAX_RENDER_LINES / Math.max(1, maxShown)));
	const remainder = operations.length - maxShown;
	const suffix = remainder > 0
		? `\n${theme.fg("muted", `… ${remainder} more edit blocks${toolOutputDetailHint(theme, ctx.expanded, true)}`)}`
		: "";
	// Synchronous, unhighlighted first (see renderUnifiedRows): the highlighted pass below
	// replaces only the colors, so this frame already carries the final row count.
	const plainSections = diffs.slice(0, maxShown).map((diff) => renderSplitPlain(diff, previewLines, dc, branchWidth));
	ctx.state._ptBody = `${operations.length} edits ${summary}\n${joinEditDiffSections(plainSections)}${suffix}`;
	ctx.state._ptDisplay = indentBranchBlock(withBranch(ctx.state._ptBody, theme, false, true));
	mapWithConcurrency(diffs.slice(0, maxShown), DIFF_RENDER_CONCURRENCY, async (diff, index) => {
		return renderDiffBody(plainSections[index], diff, language, previewLines, dc, branchWidth, "split")
			.catch(() => summarizeDiff(diff.added, diff.removed));
	})
		.then((sections) => {
			if (ctx.state._pk !== key) return;
			ctx.state._ptBody = `${operations.length} edits ${summary}\n${joinEditDiffSections(sections)}${suffix}`;
			ctx.state._ptDisplay = indentBranchBlock(withBranch(ctx.state._ptBody, theme, false, true));
			safeInvalidate(ctx);
		})
		.catch(() => {
			if (ctx.state._pk !== key) return;
			// Keep any diff that is already on screen: the summary line alone shrinks the row.
			if (!ctx.state._ptDisplay) {
				ctx.state._ptBody = `${operations.length} edits ${summary}`;
				ctx.state._ptDisplay = indentBranchBlock(withBranch(ctx.state._ptBody, theme, false, true));
			}
			safeInvalidate(ctx);
		});
}

function stripThinkingPresentationArtifacts(text: string): string {
	if (!ANSI_PRESENT_RE.test(text) && !/^\s*thinking:\s*/i.test(text)) return text;
	let current = ANSI_PRESENT_RE.test(text) ? text.replace(ANSI_RE, "") : text;
	while (true) {
		const next = current.replace(/^(?:thinking:\s*)+/i, "").trimStart();
		if (next === current) return current;
		current = next;
	}
}

function prefixThinkingLine(text: string, _theme: Theme | undefined): string {
	if (!ANSI_PRESENT_RE.test(text) && text.startsWith("Thinking: ") && !/^Thinking:\s*thinking:\s*/i.test(text)) {
		return text;
	}
	const normalized = stripThinkingPresentationArtifacts(text).trim();
	if (!normalized) return text;
	return `Thinking: ${normalized}`;
}

function trackThinkingBlockEvents(event: any, ctx?: any): void {
	const evt = event?.assistantMessageEvent;
	const message = event?.message;
	if (!evt || typeof evt.type !== "string") return;
	function refreshThinkingChrome(): void {
		try {
			ctx?.ui?.invalidate?.();
			ctx?.ui?.requestRender?.();
		} catch { /* noop */ }
		// Pi may call AssistantMessageComponent.updateContent before extension
		// handlers run on the same thinking_end event — nudge one more frame.
		setTimeout(() => {
			try {
				ctx?.ui?.invalidate?.();
				ctx?.ui?.requestRender?.();
			} catch { /* noop */ }
		}, 0);
	}

	if (evt.type === "thinking_start") {
		thinkingBlockInFlight = true;
		thinkingBlockStartMs = Date.now();
		lastThinkingBlockDurationMs = undefined;
		if (message?.role === "assistant") {
			(message as any)[THINKING_ACTIVE_KEY] = true;
			delete (message as any)[THINKING_DURATION_KEY];
		}
		refreshThinkingChrome();
		return;
	}
	if (evt.type === "thinking_end") {
		thinkingBlockInFlight = false;
		const duration = Math.max(0, Date.now() - thinkingBlockStartMs);
		if (message?.role === "assistant") delete (message as any)[THINKING_ACTIVE_KEY];
		lastThinkingBlockDurationMs = duration;
		if (message?.role === "assistant") (message as any)[THINKING_DURATION_KEY] = duration;
		refreshThinkingChrome();
		return;
	}
	// Fallback: some providers/models never emit thinking_end (a second
	// thinking_start can overwrite the first, or the turn can end with toolUse).
	// The live "Thinking..." row would otherwise stick forever while later calls
	// run normally. Any non-thinking stream event on the same assistant message
	// means thinking is no longer the live activity: freeze the elapsed time into
	// a "Thought for Xs" duration so the row always resolves.
	if ((message as any)?.[THINKING_ACTIVE_KEY] || thinkingBlockInFlight) {
		if (evt.type === "text_start" || evt.type === "text_delta" || evt.type === "toolcall_start" || evt.type === "toolcall_end") {
			thinkingBlockInFlight = false;
			const duration = thinkingBlockStartMs > 0 ? Math.max(0, Date.now() - thinkingBlockStartMs) : undefined;
			if (message?.role === "assistant") delete (message as any)[THINKING_ACTIVE_KEY];
			if (typeof duration === "number") {
				lastThinkingBlockDurationMs = duration;
				if (message?.role === "assistant") (message as any)[THINKING_DURATION_KEY] = duration;
			}
			refreshThinkingChrome();
		}
	}
}

/**
 * Track pi's thinking level: the shimmer band is painted in that level's theme color, so it
 * has to follow /thinking, Shift+Tab, model switches, and session resume.
 */
function registerThinkingLevelTracking(pi: ExtensionAPI): void {
	pi.on("thinking_level_select", async (event) => {
		if (typeof event?.level === "string") _thinkingLevel = event.level;
	});
	const refresh = (_event: unknown, ctx: any) => {
		let level: unknown = ctx?.thinkingLevel;
		if (typeof level !== "string") {
			try {
				level = (pi as any)?.getThinkingLevel?.();
			} catch {
				level = undefined;
			}
		}
		if (typeof level === "string") _thinkingLevel = level;
	};
	pi.on("session_start", async (event, ctx) => refresh(event, ctx));
	pi.on("turn_start", async (event, ctx) => refresh(event, ctx));
}

function registerThinkingLabels(pi: ExtensionAPI): void {
	const patchMessage = (event: any, theme?: Theme) => {
		// Keep theme-derived border / dim text colors in sync with the
		// active pi theme. Cheap when the theme hasn't changed (identity check).
		if (theme) applyThemePaletteIfNeeded(theme);
		const message = event?.message;
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return;
		for (const block of message.content) {
			if (block && block.type === "thinking" && typeof block.thinking === "string") {
				block.thinking = prefixThinkingLine(block.thinking, theme);
			}
		}
	};
	pi.on("before_agent_start", async () => {
		// Start once per top-level request. Steering/follow-up messages can be
		// injected while the agent is already active; those must not reset the
		// request timer or the turn counter.
		if (currentAgentWorkStartMs === undefined) {
			currentAgentWorkStartMs = Date.now();
			currentRunTurnCount = 0;
		}
		currentAssistantMessageStartMs = undefined;
	});
	pi.on("agent_start", async () => {
		if (currentAgentWorkStartMs === undefined) {
			currentAgentWorkStartMs = Date.now();
			currentRunTurnCount = 0;
		}
		currentAssistantMessageStartMs = undefined;
	});
	pi.on("turn_start", async () => {
		// Count pi's turns for this run so the status line reports how many actually
		// fired, rather than how many prompts the user sent.
		if (currentAgentWorkStartMs === undefined) {
			// Hosts that never emit before_agent_start/agent_start: treat the first
			// turn as the run boundary so the counter cannot leak across runs.
			currentAgentWorkStartMs = Date.now();
			currentRunTurnCount = 1;
			return;
		}
		currentRunTurnCount++;
	});
	pi.on("message_start", async (event: any) => {
		const message = event?.message;
		if (message?.role === "user" && currentAgentWorkStartMs === undefined) {
			currentAgentWorkStartMs = Date.now();
			currentRunTurnCount = 0;
		}
		if (message?.role === "assistant") {
			currentAssistantMessageStartMs = Date.now();
			(message as any)[WORKED_START_KEY] = currentAssistantMessageStartMs;
			// A new assistant message starts a fresh thinking lifecycle. Without
			// this, a missing thinking_end on the previous message leaves the
			// global in-flight flag set and the next message renders a stale
			// "Thinking..." row until its own thinking events arrive.
			thinkingBlockInFlight = false;
			delete (message as any)[THINKING_ACTIVE_KEY];
		}
	});
	pi.on("message_update", async (event, ctx) => {
		trackThinkingBlockEvents(event, ctx);
		patchMessage(event, ctx.ui?.theme);
	});
	pi.on("message_end", async (event, ctx) => {
		const message = (event as any)?.message;
		if (message?.role === "assistant") {
			// Belt-and-suspenders: if thinking_end never fired (provider skipped
			// it, or the turn ended on toolUse/text), freeze any live "Thinking..."
			// into its "Thought for Xs" duration here so the row always resolves
			// at the end of the message instead of sticking into later calls.
			thinkingBlockInFlight = false;
			delete (message as any)[THINKING_ACTIVE_KEY];
			if (typeof (message as any)[THINKING_DURATION_KEY] !== "number") {
				const duration = thinkingBlockStartMs > 0 ? Math.max(0, Date.now() - thinkingBlockStartMs) : undefined;
				if (typeof duration === "number" && duration > 0) {
					lastThinkingBlockDurationMs = duration;
					(message as any)[THINKING_DURATION_KEY] = duration;
				} else if (typeof lastThinkingBlockDurationMs === "number" && lastThinkingBlockDurationMs > 0) {
					(message as any)[THINKING_DURATION_KEY] = lastThinkingBlockDurationMs;
				}
			}
			thinkingBlockStartMs = 0;
			const started = typeof currentAgentWorkStartMs === "number"
				? currentAgentWorkStartMs
				: typeof (message as any)[WORKED_START_KEY] === "number"
					? (message as any)[WORKED_START_KEY]
					: currentAssistantMessageStartMs;
			const isFinalAssistantMessage = message.stopReason === "stop";
			if (started !== undefined && isFinalAssistantMessage) {
				const durationMs = Math.max(0, Date.now() - started);
				const turns = Math.max(1, currentRunTurnCount);
				sessionWorkedTotalMs += durationMs;
				lastRunTurnCount = turns;
				(message as any)[WORKED_DURATION_KEY] = durationMs;
				(message as any)[WORKED_SESSION_TOTAL_KEY] = sessionWorkedTotalMs;
				(message as any)[WORKED_TURNS_KEY] = turns;
				// Duration metadata drives the assistant component's TUI-only status line.
				// Message content stays presentation-neutral for persistence and consumers.
			}
			currentAssistantMessageStartMs = undefined;
		}
		patchMessage(event, ctx.ui?.theme);
		try {
			(ctx as any)?.ui?.invalidate?.();
			(ctx as any)?.ui?.requestRender?.();
		} catch { /* noop */ }
	});
	pi.on("agent_end", async () => {
		currentAgentWorkStartMs = undefined;
		currentAssistantMessageStartMs = undefined;
		// The chunk that was live is closed: stop animating it and stamp its final total.
		stopLiveGroupFrame();
	});
	pi.on("session_start", async (_event, ctx) => {
		// Reset live state on every session transition. Seed from the complete active
		// branch so resume, fork, tree navigation, and compaction retain prior work
		// totals without counting the idle gaps between prompts.
		currentAgentWorkStartMs = undefined;
		currentAssistantMessageStartMs = undefined;
		stopLiveGroupFrame();
		seedSessionTiming(sessionBranchMessages(ctx) ?? []);
	});
	pi.on("context", async (event, ctx) => {
		const messages = (event as any)?.messages;
		if (!Array.isArray(messages)) return;
		// getBranch() remains complete across compaction; event.messages is a safe
		// fallback for hosts that don't expose a session manager.
		seedSessionTiming(sessionBranchMessages(ctx) ?? messages);
		for (const msg of messages) {
			if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
			for (const block of msg.content) {
				if (block && block.type === "thinking" && typeof block.thinking === "string") {
					block.thinking = stripThinkingPresentationArtifacts(block.thinking);
				}
				if (block && block.type === "text" && typeof block.text === "string") {
					block.text = stripWorkedDurationLine(block.text);
				}
			}
		}
	});
}

function getMode<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

const CORE_TOOL_OVERRIDES = new Set(["read", "bash", "grep", "find", "ls", "write", "edit"]);

const OPENAI_STYLE_TOOL_NAMES = new Set([
	"apply_patch",
	"webfetch",
	"question",
	"questionnaire",
	"context_tag",
	"context_log",
	"context_checkout",
	"annotate",
	"web_search",
	"code_search",
	"fetch_content",
	"get_search_content",
	"alpha_search",
	"alpha_get_paper",
	"alpha_ask_paper",
	"alpha_annotate_paper",
	"alpha_list_annotations",
	"alpha_read_code",
	"Skill",
	"EnterPlanMode",
	"ExitPlanMode",
	"Agent",
	"get_subagent_result",
	"steer_subagent",
	"TaskCreate",
	"TaskList",
	"TaskGet",
	"TaskUpdate",
	"TaskOutput",
	"TaskStop",
	"TaskExecute",
	// Magic Context registers specialized renderers of its own. Re-register its
	// tools through the public API so they use the same Claude-style rows as
	// every other external tool handled by this extension.
	"ctx_search",
	"ctx_memory",
	"ctx_note",
	"ctx_expand",
	"ctx_reduce",
	"todowrite",
]);

function isMcpToolCandidate(tool: unknown): boolean {
	const rec = tool as Record<string, unknown> | undefined;
	const name = typeof rec?.name === "string" ? rec.name : "";
	const description = typeof rec?.description === "string" ? rec.description : "";
	return name === "mcp" || /\bmcp\b/i.test(description);
}

function isOpenAiToolCandidate(tool: unknown): boolean {
	const rec = tool as Record<string, unknown> | undefined;
	const name = typeof rec?.name === "string" ? rec.name : "";
	if (!name || CORE_TOOL_OVERRIDES.has(name) || isMcpToolCandidate(tool)) return false;
	return OPENAI_STYLE_TOOL_NAMES.has(name);
}

function isMcpToolName(name: string): boolean {
	return name === "mcp" || /^mcp[_:-]/i.test(name) || /[_:-]mcp[_:-]/i.test(name);
}

function shouldUseGenericToolRenderer(name: unknown): boolean {
	return typeof name === "string" && name.length > 0 && !CORE_TOOL_OVERRIDES.has(name);
}

function genericToolLabel(name: string): string {
	return isMcpToolName(name) ? "mcp" : name.toLowerCase();
}

function renderGenericToolCall(name: string, args: any, theme: Theme, ctx: any, preferredLabel?: string): Text {
	syncToolCallStatus(ctx);
	ctx.state._openAiPatchFiles = [];
	// Agent / subagent tools get a size-breathing pending marker, not on/off ●.
	if (isAgentFamilyToolName(name)) ctx.state._agentBreathe = true;
	const sp = (path: string) => shortPath(ctx.cwd ?? process.cwd(), path);
	const summary = stableCallSummary(ctx, "_callSummary", () => summarizeGenericToolCall(name, args, theme, sp));
	const label = typeof preferredLabel === "string" && preferredLabel.trim() ? preferredLabel.trim() : genericToolLabel(name);
	return makeText(
		ctx.lastComponent,
		toolHeader(label, summary, theme, toolStatusDot(ctx, theme), liveLineCountTrailing(ctx, theme)),
	);
}

function renderGenericToolResult(name: string, result: any, options: any, theme: Theme, ctx: any): Text {
	if (isMcpToolName(name)) {
		return renderMcpToolResult(result, !!options?.expanded, !!options?.isPartial, theme, ctx);
	}
	return renderOpenAiToolResult(
		name,
		{ content: result.content, details: result.details },
		!!options?.expanded,
		!!options?.isPartial,
		theme,
		ctx,
	);
}

function getTextContent(result: any): string {
	if (!Array.isArray(result?.content)) return "";
	return result.content
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join("\n");
}

function collectNonEmptyLines(text: string, tailLimit?: number): { lines: string[]; total: number } {
	const keepTail = typeof tailLimit === "number" && Number.isFinite(tailLimit);
	const limit = keepTail ? Math.max(0, Math.floor(tailLimit)) : 0;
	const lines: string[] = [];
	let total = 0;
	let start = 0;
	while (start <= text.length) {
		const newline = text.indexOf("\n", start);
		const end = newline === -1 ? text.length : newline;
		const line = text.slice(start, end);
		if (line.trim().length > 0) {
			total++;
			if (!keepTail) {
				lines.push(line);
			} else if (limit > 0) {
				if (lines.length === limit) lines.shift();
				lines.push(line);
			}
		}
		if (newline === -1) break;
		start = newline + 1;
	}
	return { lines, total };
}

function lineCountLabel(count: number): string {
	return `${count} line${count === 1 ? "" : "s"}`;
}

function runningPreviewBlock(
	result: any,
	_statusText: string,
	expanded: boolean,
	theme: Theme,
	ctx: any,
	options: { lines?: string[]; totalLineCount?: number; styleLine?: (line: string) => string; tail?: boolean } = {},
): string {
	// Keep the header status dot blinking while partial output streams. Call/result
	// renderers share rendererState, so setupBlinkTimer here re-arms the same key
	// the call header uses — but only when this tool actually started executing.
	syncToolCallStatus(ctx);
	if (ctx?.state?._toolStatus === "pending") setupBlinkTimer(ctx);
	else clearBlinkTimer(ctx);

	const limit = liveToolPreviewLimit();
	let lines: string[];
	let totalLineCount: number;
	if (options.lines) {
		lines = options.lines;
		totalLineCount = options.totalLineCount ?? lines.length;
	} else {
		// Single-pass collect; when collapsed only keep the preview window.
		const raw = getTextContent(result).replace(/\r\n/g, "\n").trimEnd();
		const collected = collectNonEmptyLines(raw, expanded ? undefined : limit);
		lines = collected.lines;
		totalLineCount = collected.total;
	}
	// Line count lives on the tool heading (via liveLineCountTrailing); keep it in
	// renderer state so the next renderCall pass can pick it up.
	if (ctx?.state) ctx.state._liveLineCount = totalLineCount;

	if (!liveToolPreviewEnabled() || limit <= 0 || totalLineCount === 0) {
		// No status row — the blinking ● on the header is the only running indicator.
		return "";
	}

	const styleLine = options.styleLine ?? ((line: string) => theme.fg("dim", line || " "));
	// Prefer pre-collected tail lines; otherwise only take what the preview needs.
	const previewSource = options.tail && !expanded
		? (lines.length > limit ? lines.slice(-limit) : lines)
		: lines;
	// For tail previews the "earlier lines" prefix owns the remaining count — pass
	// previewSource.length so buildPreviewText doesn't also append "more lines".
	const previewTotal = options.tail && !expanded ? previewSource.length : totalLineCount;
	let preview = buildPreviewText(previewSource, expanded, theme, limit, previewTotal, styleLine);
	if (options.tail && !expanded && totalLineCount > previewSource.length) {
		preview = `${theme.fg("muted", `... (${totalLineCount - previewSource.length} earlier lines${toolOutputDetailHint(theme, expanded, true)})`)}\n${preview}`;
	}
	return withBranch(preview, theme);
}

function buildPersistentBashPreview(lines: string[], theme: Theme): string {
	const limit = liveToolPreviewLimit();
	if (!liveToolPreviewEnabled() || limit <= 0 || lines.length === 0) return "";
	const start = Math.max(0, lines.length - limit);
	let preview = "";
	for (let i = start; i < lines.length; i++) {
		const styled = theme.fg("dim", lines[i]);
		preview += i === start ? styled : `\n${styled}`;
	}
	const earlier = start;
	if (earlier > 0) {
		preview = `${theme.fg("muted", `... (${earlier} earlier lines)`)}\n${preview}`;
	}
	return preview;
}

function getStringArg(args: any, ...keys: string[]): string {
	for (const key of keys) {
		const value = args?.[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

function getStringArrayArg(args: any, ...keys: string[]): string[] {
	for (const key of keys) {
		const value = args?.[key];
		if (!Array.isArray(value)) continue;
		const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
		if (items.length > 0) return items;
	}
	return [];
}

function extractApplyPatchFiles(patchText: string): string[] {
	if (!patchText) return [];
	const files = new Set<string>();
	for (const match of patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
		const filePath = match[1]?.trim();
		if (filePath) files.add(filePath);
	}
	return [...files];
}

interface ApplyPatchChangePreview {
	kind: "add" | "update" | "delete";
	path: string;
	displayPath: string;
	moveTo?: string;
	diff: ParsedDiff;
	language: BundledLanguage | undefined;
	hunks: number;
	summary: string;
	line: number;
}

interface ApplyPatchPreview {
	changes: ApplyPatchChangePreview[];
	totalAdded: number;
	totalRemoved: number;
	totalHunks: number;
	totalLines: number;
	summary: string;
}

interface ApplyPatchResultMeta {
	changeCount: number;
	totalAdded: number;
	totalRemoved: number;
	totalHunks: number;
	totalLines: number;
	firstChange?: {
		displayPath: string;
		kind: ApplyPatchChangePreview["kind"];
		hunks: number;
		line: number;
		added: number;
		removed: number;
	};
}

function buildApplyPatchResultMeta(preview: ApplyPatchPreview): ApplyPatchResultMeta {
	const firstChange = preview.changes[0];
	return {
		changeCount: preview.changes.length,
		totalAdded: preview.totalAdded,
		totalRemoved: preview.totalRemoved,
		totalHunks: preview.totalHunks,
		totalLines: preview.totalLines,
		firstChange: firstChange
			? {
				displayPath: firstChange.displayPath,
				kind: firstChange.kind,
				hunks: firstChange.hunks,
				line: firstChange.line,
				added: firstChange.diff.added,
				removed: firstChange.diff.removed,
			}
			: undefined,
	};
}

function countDiffHunks(diff: ParsedDiff): number {
	return diff.lines.length === 0 ? 0 : diff.lines.filter((line) => line.type === "sep").length + 1;
}

function getApplyPatchLine(diff: ParsedDiff, kind: ApplyPatchChangePreview["kind"]): number {
	if (kind === "add") {
		return diff.lines.find((line) => line.type === "add" && line.newNum !== null)?.newNum ?? 1;
	}
	if (kind === "delete") {
		return diff.lines.find((line) => line.type === "del" && line.oldNum !== null)?.oldNum ?? 1;
	}
	for (const line of diff.lines) {
		if (line.type === "add" && line.newNum !== null) return line.newNum;
		if (line.type === "del" && line.oldNum !== null) return line.oldNum;
	}
	return 0;
}

function parsePatchBodyLine(rawLine: string): { marker: "+" | "-" | " "; content: string } {
	const marker = rawLine[0];
	if (marker === "+" || marker === "-" || marker === " ") return { marker, content: rawLine.slice(1) };
	return { marker: " ", content: rawLine };
}

function findLineSequence(haystack: string[], needle: string[], fromIndex = 0): number {
	if (needle.length === 0) return Math.max(0, fromIndex);
	outer: for (let i = Math.max(0, fromIndex); i <= haystack.length - needle.length; i++) {
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) continue outer;
		}
		return i;
	}
	return -1;
}

function inferApplyPatchHunkStarts(lines: string[], sourceContent: string): Array<{ oldStart: number | null; newStart: number | null }> {
	const sourceLines = normalizeToLf(sourceContent).split("\n");
	const hunks: string[][] = [];
	let currentHunk: string[] | null = null;
	for (const rawLine of lines) {
		if (rawLine.startsWith("*** Move to: ")) continue;
		if (rawLine.startsWith("@@")) {
			if (currentHunk) hunks.push(currentHunk);
			currentHunk = [];
			continue;
		}
		if (!currentHunk) currentHunk = [];
		currentHunk.push(rawLine);
	}
	if (currentHunk) hunks.push(currentHunk);

	const starts: Array<{ oldStart: number | null; newStart: number | null }> = [];
	let searchFrom = 0;
	let lineDelta = 0;
	for (const hunk of hunks) {
		const oldLines = hunk
			.map((rawLine) => parsePatchBodyLine(rawLine))
			.filter((line) => line.marker !== "+")
			.map((line) => line.content);
		let matchIndex = findLineSequence(sourceLines, oldLines, searchFrom);
		if (matchIndex === -1) matchIndex = findLineSequence(sourceLines, oldLines, 0);
		const oldStart = matchIndex === -1 ? null : matchIndex + 1;
		const newStart = oldStart === null ? null : oldStart + lineDelta;
		starts.push({ oldStart, newStart });
		if (matchIndex === -1) continue;
		searchFrom = matchIndex + oldLines.length;
		const added = hunk.filter((rawLine) => parsePatchBodyLine(rawLine).marker === "+").length;
		const removed = hunk.filter((rawLine) => parsePatchBodyLine(rawLine).marker === "-").length;
		lineDelta += added - removed;
	}
	return starts;
}

function stripPatchLinePrefix(line: string, prefix: "+" | "-"): string {
	return line.startsWith(prefix) ? line.slice(1) : line;
}

function trimDiffSeparators(lines: DiffLine[]): DiffLine[] {
	const trimmed = [...lines];
	while (trimmed[0]?.type === "sep") trimmed.shift();
	while (trimmed[trimmed.length - 1]?.type === "sep") trimmed.pop();
	return trimmed;
}

function parseApplyPatchUpdateDiff(lines: string[], sourceContent?: string): ParsedDiff {
	const diffLines: DiffLine[] = [];
	let added = 0;
	let removed = 0;
	let chars = 0;
	let oldLine: number | null = null;
	let newLine: number | null = null;
	let inHunk = false;
	const inferredStarts = sourceContent ? inferApplyPatchHunkStarts(lines, sourceContent) : [];
	let hunkIndex = 0;

	for (const rawLine of lines) {
		if (rawLine.startsWith("*** Move to: ")) continue;
		if (rawLine.startsWith("@@")) {
			if (diffLines.length > 0 && diffLines[diffLines.length - 1]?.type !== "sep") {
				diffLines.push({ type: "sep", oldNum: null, newNum: null, content: "" });
			}
			const match = rawLine.match(/^@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/);
			const inferred = inferredStarts[hunkIndex] ?? { oldStart: null, newStart: null };
			oldLine = match ? Number.parseInt(match[1], 10) : inferred.oldStart;
			newLine = match ? Number.parseInt(match[2], 10) : inferred.newStart;
			hunkIndex++;
			inHunk = true;
			continue;
		}
		if (rawLine === "\\ No newline at end of file") continue;
		if (!inHunk) {
			const inferred = inferredStarts[hunkIndex] ?? { oldStart: null, newStart: null };
			oldLine = inferred.oldStart;
			newLine = inferred.newStart;
			hunkIndex++;
			inHunk = true;
		}

		const { marker, content } = parsePatchBodyLine(rawLine);

		chars += content.length;
		if (marker === "+") {
			diffLines.push({ type: "add", oldNum: null, newNum: newLine, content });
			added++;
			if (newLine !== null) newLine++;
			continue;
		}
		if (marker === "-") {
			diffLines.push({ type: "del", oldNum: oldLine, newNum: null, content });
			removed++;
			if (oldLine !== null) oldLine++;
			continue;
		}
		diffLines.push({ type: "ctx", oldNum: oldLine, newNum: newLine, content });
		if (oldLine !== null) oldLine++;
		if (newLine !== null) newLine++;
	}

	return {
		lines: trimDiffSeparators(diffLines),
		added,
		removed,
		chars,
	};
}

function parseApplyPatchPreview(patchText: string, sp: (path: string) => string, cwd = process.cwd()): ApplyPatchPreview {
	const normalized = patchText.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	const changes: ApplyPatchChangePreview[] = [];
	let index = 0;

	const fileHeader = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
	const endHeader = /^\*\*\* End Patch$/;

	while (index < lines.length) {
		const line = lines[index];
		if (!line || line === "*** Begin Patch") {
			index++;
			continue;
		}
		if (endHeader.test(line)) break;
		const header = line.match(fileHeader);
		if (!header) {
			index++;
			continue;
		}

		const kind = header[1].toLowerCase() as ApplyPatchChangePreview["kind"];
		const path = header[2].trim();
		index++;

		let moveTo: string | undefined;
		const body: string[] = [];
		while (index < lines.length && !fileHeader.test(lines[index]) && !endHeader.test(lines[index])) {
			if (lines[index].startsWith("*** Move to: ")) {
				moveTo = lines[index].slice("*** Move to: ".length).trim();
				index++;
				continue;
			}
			body.push(lines[index]);
			index++;
		}

		const displayPath = moveTo ? `${sp(path)} ${BORDER_COLOR}→${TRANSPARENT_RESET} ${sp(moveTo)}` : sp(path);
		let sourceContent: string | undefined;
		if (kind === "update") {
			try {
				sourceContent = readFileSync(resolve(cwd, path), "utf8");
			} catch {
				sourceContent = undefined;
			}
		}
		const diff = kind === "add"
			? parseDiff("", body.map((entry) => stripPatchLinePrefix(entry, "+")).join("\n"))
			: kind === "delete"
				? parseDiff(body.map((entry) => stripPatchLinePrefix(entry, "-")).join("\n"), "")
				: parseApplyPatchUpdateDiff(body, sourceContent);
		changes.push({
			kind,
			path,
			displayPath,
			moveTo,
			diff,
			language: lang(moveTo || path),
			hunks: countDiffHunks(diff),
			summary: summarizeDiff(diff.added, diff.removed),
			line: getApplyPatchLine(diff, kind),
		});
	}

	const totalAdded = changes.reduce((sum, change) => sum + change.diff.added, 0);
	const totalRemoved = changes.reduce((sum, change) => sum + change.diff.removed, 0);
	const totalHunks = changes.reduce((sum, change) => sum + change.hunks, 0);
	const totalLines = changes.reduce((sum, change) => sum + change.diff.lines.length, 0);
	return {
		changes,
		totalAdded,
		totalRemoved,
		totalHunks,
		totalLines,
		summary: summarizeDiff(totalAdded, totalRemoved),
	};
}

function describeApplyPatchChange(change: ApplyPatchChangePreview): string {
	if (change.moveTo) return `Rename ${change.displayPath}`;
	if (change.kind === "add") return `Create ${change.displayPath}`;
	if (change.kind === "delete") return `Delete ${change.displayPath}`;
	return `Update ${change.displayPath}`;
}

function formatLineMeta(line: number, theme: Theme): string {
	return line > 0 ? ` ${theme.fg("muted", `at line ${line}`)}` : "";
}

function formatApplyPatchLine(change: ApplyPatchChangePreview, theme: Theme): string {
	return formatLineMeta(change.line, theme);
}

function getCachedApplyPatchPreview(patchText: string, sp: (path: string) => string, ctx: any): ApplyPatchPreview | null {
	if (!patchText) return null;
	const key = `apply-meta:${ctx.cwd ?? process.cwd()}:${hashText(patchText)}`;
	if (ctx.state?._applyPatchMetaKey === key && ctx.state._applyPatchPreview) {
		return ctx.state._applyPatchPreview as ApplyPatchPreview;
	}
	try {
		const preview = parseApplyPatchPreview(patchText, sp, ctx.cwd ?? process.cwd());
		if (ctx.state) {
			ctx.state._applyPatchMetaKey = key;
			ctx.state._applyPatchPreview = preview;
			ctx.state._applyPatchMeta = buildApplyPatchResultMeta(preview);
		}
		return preview;
	} catch {
		return null;
	}
}

function getApplyPatchResultMeta(args: any, ctx: any, sp: (path: string) => string): ApplyPatchResultMeta | null {
	const patchText = getStringArg(args ?? ctx?.args, "patchText", "patch_text");
	if (!patchText) return null;
	const preview = getCachedApplyPatchPreview(patchText, sp, ctx);
	return preview && ctx.state?._applyPatchMeta ? (ctx.state._applyPatchMeta as ApplyPatchResultMeta) : null;
}

function renderApplyPatchCall(args: any, theme: Theme, ctx: any, sp: (path: string) => string): Text {
	syncToolCallStatus(ctx);
	const patchText = getStringArg(args, "patchText", "patch_text");
	const summary = stableCallSummary(ctx, "_callSummary", () => summarizeOpenAiToolCall("apply_patch", args, theme, sp));
	const hdr = toolHeader("apply_patch", summary, theme, toolStatusDot(ctx, theme), liveLineCountTrailing(ctx, theme));

	if (!ctx.argsComplete) return makeText(ctx.lastComponent, hdr);
	const preview = getCachedApplyPatchPreview(patchText, sp, ctx);
	if (!preview || preview.changes.length === 0) {
		ctx.state._openAiPatchFiles = [];
		return makeText(ctx.lastComponent, hdr);
	}
	ctx.state._openAiPatchFiles = preview.changes.map((change) => change.displayPath);

	const diffWidth = contextDiffWidth(ctx);
	const key = `apply-preview:${ctx.state._applyPatchMetaKey ?? hashText(patchText)}:${diffWidth}:${ctx.expanded ? 1 : 0}`;
	if (ctx.state._applyPatchPreviewKey !== key) {
		ctx.state._applyPatchPreviewKey = key;
		// No placeholder: both branches below publish an unhighlighted body synchronously.
		const dc = resolveDiffColors(theme);
		if (preview.changes.length === 1) {
			const [change] = preview.changes;
			const heading = `${describeApplyPatchChange(change)} ${change.summary}${formatApplyPatchLine(change, theme)}`;
			// Synchronous, unhighlighted first: same rows and height as the highlighted pass below.
			const patchLineCap = ctx.expanded ? MAX_PREVIEW_LINES : 32;
			const plainBody = renderSplitPlain(change.diff, patchLineCap, dc, diffWidth);
			ctx.state._applyPatchPreviewBody = `${heading}\n${plainBody}`;
			ctx.state._applyPatchPreviewDisplay = withBranch(ctx.state._applyPatchPreviewBody, theme, false, true);
			renderDiffBody(plainBody, change.diff, change.language, patchLineCap, dc, diffWidth, "split")
				.then((rendered) => {
					if (ctx.state._applyPatchPreviewKey !== key) return;
					ctx.state._applyPatchPreviewBody = `${heading}\n${rendered}`;
					ctx.state._applyPatchPreviewDisplay = withBranch(ctx.state._applyPatchPreviewBody, theme, false, true);
					safeInvalidate(ctx);
				})
				.catch(() => {
					if (ctx.state._applyPatchPreviewKey !== key) return;
					// Keep any diff that is already on screen: the summary line alone shrinks the row.
					if (!ctx.state._applyPatchPreviewDisplay) {
						ctx.state._applyPatchPreviewBody = `${describeApplyPatchChange(change)} ${change.summary}${formatApplyPatchLine(change, theme)}`;
						ctx.state._applyPatchPreviewDisplay = withBranch(ctx.state._applyPatchPreviewBody, theme, false, true);
					}
					safeInvalidate(ctx);
				});
		} else {
			const maxShown = ctx.expanded ? preview.changes.length : Math.min(preview.changes.length, 3);
			const previewLines = ctx.expanded
				? Math.max(6, Math.floor(MAX_RENDER_LINES / Math.max(1, maxShown)))
				: Math.max(8, Math.floor(MAX_PREVIEW_LINES / Math.max(1, maxShown)));
			const shown = preview.changes.slice(0, maxShown);
			const remainder = preview.changes.length - maxShown;
			const suffix = remainder > 0
				? `\n${theme.fg("muted", `… ${remainder} more file patches${toolOutputDetailHint(theme, ctx.expanded, true)}`)}`
				: "";
			const fileSummary = `${preview.changes.length} files ${preview.summary}`;
			const sectionHeading = (change: ApplyPatchChangePreview) => `${describeApplyPatchChange(change)} ${change.summary}${formatApplyPatchLine(change, theme)}`;
			// Synchronous, unhighlighted first: same rows and height as the highlighted pass below.
			const plainSections = shown.map((change) => renderSplitPlain(change.diff, previewLines, dc, diffWidth));
			ctx.state._applyPatchPreviewBody = `${fileSummary}\n\n${shown.map((change, index) => `${sectionHeading(change)}\n${plainSections[index]}`).join("\n\n")}${suffix}`;
			ctx.state._applyPatchPreviewDisplay = withBranch(ctx.state._applyPatchPreviewBody, theme, false, true);
			mapWithConcurrency(shown, DIFF_RENDER_CONCURRENCY, async (change, index) =>
				renderDiffBody(plainSections[index], change.diff, change.language, previewLines, dc, diffWidth, "split")
					.then((rendered) => `${sectionHeading(change)}\n${rendered}`)
					.catch(() => `${index + 1}. ${sectionHeading(change)}`),
			)
				.then((sections) => {
					if (ctx.state._applyPatchPreviewKey !== key) return;
					ctx.state._applyPatchPreviewBody = `${fileSummary}\n\n${sections.join("\n\n")}${suffix}`;
					ctx.state._applyPatchPreviewDisplay = withBranch(ctx.state._applyPatchPreviewBody, theme, false, true);
					safeInvalidate(ctx);
				})
				.catch(() => {
					if (ctx.state._applyPatchPreviewKey !== key) return;
					// Keep any diff that is already on screen: the summary line alone shrinks the row.
					if (!ctx.state._applyPatchPreviewDisplay) {
						ctx.state._applyPatchPreviewBody = `${preview.changes.length} files ${preview.summary}`;
						ctx.state._applyPatchPreviewDisplay = withBranch(ctx.state._applyPatchPreviewBody, theme, false, true);
					}
					safeInvalidate(ctx);
				});
		}
	}

	const body = ctx.state._applyPatchPreviewDisplay as string | undefined;
	return makeResponsiveDiffText(ctx, ctx.lastComponent, body ? `${hdr}\n${body}` : hdr);
}

function renderApplyPatchResult(result: any, isPartial: boolean, theme: Theme, ctx: any): Text {
	if (isPartial) {
		return makeText(ctx.lastComponent, runningPreviewBlock(result, theme.fg("dim", "Applying Patch..."), !!ctx?.expanded, theme, ctx));
	}
	clearBlinkTimer(ctx);
	setToolStatus(ctx, ctx.isError ? "error" : "success");

	if (ctx.isError) {
		const raw = getTextContent(result).trim();
		const firstLine = raw ? raw.split("\n")[0] : "Apply patch failed";
		return makeText(ctx.lastComponent, withBranch(theme.fg("error", firstLine), theme));
	}

	const meta = getApplyPatchResultMeta(ctx.args, ctx, (path: string) => shortPath(ctx.cwd ?? process.cwd(), path));
	if (!meta || meta.changeCount === 0) {
		return makeText(ctx.lastComponent, withBranch(theme.fg("success", "Applied"), theme));
	}

	if (meta.changeCount === 1 && meta.firstChange) {
		const change = meta.firstChange;
		const summary = diffSummaryWithMeta(change.added, change.removed, change.hunks, change.kind === "add" ? "new file" : change.kind === "delete" ? "delete" : "");
		return makeText(ctx.lastComponent, withBranch(`${theme.fg("success", "Applied")} ${theme.fg("muted", change.displayPath)} ${summary}${formatLineMeta(change.line, theme)}`, theme));
	}

	const summary = diffSummaryWithMeta(meta.totalAdded, meta.totalRemoved, meta.totalHunks, "");
	return makeText(ctx.lastComponent, withBranch(`${theme.fg("success", "Applied")} ${meta.changeCount} files ${summary}${meta.totalLines ? ` ${theme.fg("muted", `(${meta.totalLines} diff lines)`)}` : ""}`, theme));
}

function summarizeMcpToolCall(args: any, theme: Theme): string {
	const tool = getStringArg(args, "tool");
	if (tool) return args?.server ? `${args.server}:${tool}` : tool;
	const connect = getStringArg(args, "connect");
	if (connect) return `connect ${connect}`;
	const search = getStringArg(args, "search", "describe", "server", "action");
	if (search) return summarizeText(search, 72);
	return theme.fg("muted", "status");
}

function summarizeGenericToolCall(name: string, args: any, theme: Theme, sp: (path: string) => string): string {
	const ptc = summarizePtcToolCall(name, args);
	if (ptc !== undefined) return ptc;
	if (isMcpToolName(name)) return summarizeMcpToolCall(args, theme);
	return summarizeOpenAiToolCall(name, args, theme, sp);
}

function renderMcpToolResult(result: any, expanded: boolean, isPartial: boolean, theme: Theme, ctx: any): Text {
	if (isPartial) {
		return makeText(ctx.lastComponent, runningPreviewBlock(result, theme.fg("dim", "MCP running..."), expanded, theme, ctx, {
			styleLine: (line) => theme.fg("toolOutput", line || " "),
		}));
	}
	clearBlinkTimer(ctx);
	setToolStatus(ctx, ctx.isError ? "error" : "success");

	const mode = getMode(readSettings().mcpOutputMode, ["hidden", "summary", "preview"] as const, "preview");
	if (mode === "hidden") return makeText(ctx.lastComponent, "");

	const raw = getTextContent(result).trim();
	const lines = raw ? raw.split("\n") : [];
	if (lines.length === 0) {
		return makeText(ctx.lastComponent, withBranch(theme.fg(ctx.isError ? "error" : "success", ctx.isError ? "Failed" : "Done"), theme));
	}

	const statusText = ctx.isError ? theme.fg("error", lines[0]) : theme.fg("muted", `${lines.length} line${lines.length === 1 ? "" : "s"} returned`);
	if (mode === "summary") return makeText(ctx.lastComponent, withBranch(statusText, theme));
	if (!expanded) return makeText(ctx.lastComponent, withBranch(`${statusText}${toolOutputDetailHint(theme, expanded)}`, theme));
	const preview = buildPreviewText(
		lines,
		true,
		theme,
		previewLimit(),
		lines.length,
		(line) => theme.fg(ctx.isError ? "error" : "toolOutput", line || " "),
	);
	return makeText(ctx.lastComponent, withBranch(`${statusText}\n${preview}`, theme));
}

function summarizeOpenAiToolCall(name: string, args: any, theme: Theme, sp: (path: string) => string): string {
	switch (name) {
		case "apply_patch": {
			const patchText = getStringArg(args, "patchText", "patch_text");
			const files = extractApplyPatchFiles(patchText);
			if (files.length === 0) return theme.fg("muted", "patch");
			if (files.length === 1) return sp(files[0]);
			return `${sp(files[0])} ${theme.fg("muted", `(+${files.length - 1} files)`)}`;
		}
		case "webfetch":
			return getStringArg(args, "url") || theme.fg("muted", "fetch page");
		case "fetch_content": {
			const url = getStringArg(args, "url");
			if (url) return url;
			const urls = getStringArrayArg(args, "urls");
			if (urls.length === 0) return theme.fg("muted", "fetch content");
			if (urls.length === 1) return urls[0];
			return `${urls[0]} ${theme.fg("muted", `(+${urls.length - 1} urls)`)}`;
		}
		case "get_search_content":
			return getStringArg(args, "responseId", "response_id") || theme.fg("muted", "load cached content");
		case "web_search": {
			const query = getStringArg(args, "query");
			if (query) return summarizeText(query, 72);
			const queries = getStringArrayArg(args, "queries");
			if (queries.length === 0) return theme.fg("muted", "search web");
			if (queries.length === 1) return summarizeText(queries[0], 72);
			return `${summarizeText(queries[0], 48)} ${theme.fg("muted", `(+${queries.length - 1} queries)`)}`;
		}
		case "code_search":
			return summarizeText(getStringArg(args, "query") || "search code", 72);
		case "question":
			return summarizeText(getStringArg(args, "question") || "ask user", 72);
		case "questionnaire": {
			const questions = Array.isArray(args?.questions) ? args.questions.length : 0;
			return questions > 0 ? `${questions} questions` : theme.fg("muted", "questionnaire");
		}
		case "context_tag":
			return getStringArg(args, "name") || theme.fg("muted", "save point");
		case "context_log":
			return theme.fg("muted", "history");
		case "context_checkout":
			return getStringArg(args, "target") || theme.fg("muted", "checkout context");
		case "annotate":
			return getStringArg(args, "url") || theme.fg("muted", "current tab");
		case "alpha_search":
			return summarizeText(getStringArg(args, "query") || "search papers", 72);
		case "alpha_get_paper":
		case "alpha_ask_paper":
		case "alpha_annotate_paper":
			return getStringArg(args, "paper") || theme.fg("muted", "paper");
		case "alpha_read_code":
			return getStringArg(args, "githubUrl", "github_url") || theme.fg("muted", "repository");
		case "Skill":
			return getStringArg(args, "name") || theme.fg("muted", "run skill");
		case "EnterPlanMode":
			return theme.fg("muted", "enable read-only planning");
		case "ExitPlanMode":
			return theme.fg("muted", "present plan");
		case "Agent":
			return summarizeText(getStringArg(args, "description", "prompt") || "launch agent", 72);
		case "get_subagent_result":
			return getStringArg(args, "agent_id") || theme.fg("muted", "agent result");
		case "steer_subagent":
			return getStringArg(args, "agent_id") || theme.fg("muted", "steer agent");
		case "TaskCreate":
			return summarizeText(getStringArg(args, "subject") || "create task", 72);
		case "TaskList":
			return theme.fg("muted", "task list");
		case "TaskGet":
		case "TaskUpdate":
			return getStringArg(args, "taskId", "task_id") || theme.fg("muted", "task");
		case "TaskOutput":
		case "TaskStop":
			return getStringArg(args, "task_id", "taskId") || theme.fg("muted", "background task");
		case "TaskExecute": {
			const taskIds = getStringArrayArg(args, "task_ids", "taskIds");
			if (taskIds.length === 0) return theme.fg("muted", "start tasks");
			return taskIds.length === 1 ? taskIds[0] : `${taskIds[0]} ${theme.fg("muted", `(+${taskIds.length - 1} tasks)`)}`;
		}
		default:
			return summarizeText(
				getStringArg(args, "path", "file_path", "url", "query", "name", "subject", "tool", "description", "prompt") || name.toLowerCase(),
				72,
			);
	}
}

interface ParsedTaskListLine {
	id: string;
	status: string;
	subject: string;
}

function parseTaskListLine(line: string): ParsedTaskListLine | null {
	const match = line.match(/^#(\d+) \[([^\]]+)\] (.+)$/);
	if (!match) return null;
	return {
		id: match[1],
		status: match[2],
		subject: match[3],
	};
}

function formatTaskStatus(status: string, theme: Theme): string {
	if (status === "completed") return theme.fg("success", status);
	if (status === "in_progress") return theme.fg("warning", status);
	return theme.fg("muted", status);
}

function formatOpenAiSuccessLine(name: string, line: string, theme: Theme): string {
	const trimmed = line.trim();
	if (!trimmed) return theme.fg("success", "Done");

	if (name === "TaskCreate") {
		const match = trimmed.match(/^Task #(\d+) created successfully: (.+)$/);
		if (match) {
			return `${theme.fg("success", "Created task")} ${theme.fg("accent", `#${match[1]}`)} ${theme.fg("muted", match[2])}`;
		}
	}

	if (name === "TaskUpdate") {
		const match = trimmed.match(/^Updated task #(\d+) (.+)$/);
		if (match) {
			return `${theme.fg("success", "Updated task")} ${theme.fg("accent", `#${match[1]}`)} ${theme.fg("muted", match[2])}`;
		}
	}

	if (name === "TaskExecute") {
		return `${theme.fg("success", "Started")} ${theme.fg("muted", trimmed)}`;
	}

	if (name === "context_tag") {
		const match = trimmed.match(/^Created tag '([^']+)' at (.+)$/);
		if (match) {
			return `${theme.fg("success", "Created tag")} ${theme.fg("accent", match[1])} ${theme.fg("muted", match[2])}`;
		}
	}

	if (name === "context_checkout") {
		return `${theme.fg("success", "Checked out")} ${theme.fg("muted", trimmed.replace(/^Checked out\s*/i, ""))}`;
	}

	if (name === "TaskStop") {
		return `${theme.fg("success", "Stopped")} ${theme.fg("muted", trimmed)}`;
	}

	return theme.fg("muted", trimmed);
}

function renderTaskListResult(lines: string[], expanded: boolean, theme: Theme, ctx: any): Text {
	const tasks = lines.map(parseTaskListLine).filter((task): task is ParsedTaskListLine => task !== null);
	if (tasks.length === 0) {
		const text = lines.length === 0
			? theme.fg("muted", "no tasks")
			: buildPreviewText(lines, expanded, theme, previewLimit(), lines.length, (line) => theme.fg("dim", line));
		return makeText(ctx.lastComponent, withBranch(text, theme));
	}

	const pending = tasks.filter((task) => task.status === "pending").length;
	const inProgress = tasks.filter((task) => task.status === "in_progress").length;
	const completed = tasks.filter((task) => task.status === "completed").length;
	let summary = theme.fg("muted", `${tasks.length} tasks`);
	const parts: string[] = [];
	if (inProgress > 0) parts.push(`${theme.fg("warning", String(inProgress))} in progress`);
	if (pending > 0) parts.push(`${theme.fg("muted", String(pending))} pending`);
	if (completed > 0) parts.push(`${theme.fg("success", String(completed))} completed`);
	if (parts.length > 0) summary += ` ${theme.fg("muted", "•")} ${parts.join(` ${theme.fg("muted", "•")} `)}`;

	if (!expanded) {
		return makeText(ctx.lastComponent, withBranch(`${summary}${toolOutputDetailHint(theme, expanded)}`, theme));
	}

	const shown = tasks.slice(0, previewLimit());
	const preview = shown.map((task) => `${theme.fg("accent", `#${task.id}`)} ${formatTaskStatus(task.status, theme)} ${theme.fg("dim", task.subject)}`);
	const remaining = tasks.length - shown.length;
	if (remaining > 0) preview.push(theme.fg("muted", `… ${remaining} more tasks`));
	return makeText(ctx.lastComponent, withBranch(`${summary}\n${preview.join("\n")}`, theme));
}

function getFirstImageBlock(result: any): { data: string; mimeType: string } | undefined {
	if (!Array.isArray(result?.content)) return undefined;
	return result.content.find((block: any) => block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string");
}

function getReadImageFallback(result: any, ctx: any): string {
	const image = getFirstImageBlock(result);
	if (!image) return "";
	let dimensions;
	try {
		dimensions = getImageDimensions(image.data, image.mimeType) ?? undefined;
	} catch {
		dimensions = undefined;
	}
	const path = getStringArg(ctx.args, "path", "file_path");
	const filename = path ? shortPath(ctx.cwd ?? process.cwd(), path) : undefined;
	return imageFallback(image.mimeType, dimensions, filename);
}

function renderReadImageResult(result: any, expanded: boolean, theme: Theme, ctx: any): Text {
	const image = getFirstImageBlock(result);
	const mimeType = image?.mimeType ?? "image";
	const summary = `${theme.fg("success", "Image loaded")} ${theme.fg("muted", `[${mimeType}]`)}`;
	if (!expanded) {
		return makeText(ctx.lastComponent, withBranch(`${summary}${toolOutputDetailHint(theme, expanded)}`, theme));
	}

	const noteLines = getTextContent(result)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !/^Read image file\b/i.test(line));
	const lines = [summary, ...noteLines.map((line) => theme.fg("dim", line))];
	if (!getCapabilities().images || !ctx.showImages) {
		const fallback = getReadImageFallback(result, ctx);
		if (fallback) lines.push(theme.fg("toolOutput", fallback));
	}
	return makeText(ctx.lastComponent, withBranch(lines.join("\n"), theme));
}

function renderOpenAiToolResult(name: string, result: any, expanded: boolean, isPartial: boolean, theme: Theme, ctx: any): Text {
	if (isPartial) {
		return makeText(ctx.lastComponent, runningPreviewBlock(result, theme.fg("dim", `${name.toLowerCase()}...`), expanded, theme, ctx));
	}
	clearBlinkTimer(ctx);
	setToolStatus(ctx, ctx.isError ? "error" : "success");

	const raw = getTextContent(result).trim();
	const lines = raw ? raw.split("\n") : [];
	const patchFiles = Array.isArray(ctx.state?._openAiPatchFiles) ? ctx.state._openAiPatchFiles : [];

	if (lines.length === 0) {
		if (patchFiles.length > 0) {
			const suffix = patchFiles.length === 1 ? patchFiles[0] : `${patchFiles.length} files`;
			return makeText(ctx.lastComponent, withBranch(`${theme.fg(ctx.isError ? "error" : "success", ctx.isError ? "Failed" : "Applied")} ${theme.fg("muted", suffix)}`, theme));
		}
		return makeText(ctx.lastComponent, withBranch(theme.fg(ctx.isError ? "error" : "success", ctx.isError ? "Failed" : "Done"), theme));
	}

	if (!ctx.isError && name === "TaskList") {
		return renderTaskListResult(lines, expanded, theme, ctx);
	}

	const statusText = ctx.isError
		? theme.fg("error", lines[0])
		: theme.fg("muted", `${lines.length} line${lines.length === 1 ? "" : "s"} returned`);
	if (!expanded) {
		return makeText(ctx.lastComponent, withBranch(`${statusText}${toolOutputDetailHint(theme, expanded)}`, theme));
	}

	if (!ctx.isError && lines.length === 1) {
		return makeText(ctx.lastComponent, withBranch(formatOpenAiSuccessLine(name, lines[0], theme), theme));
	}

	const preview = lines.length === 1
		? theme.fg(ctx.isError ? "error" : "dim", lines[0])
		: buildPreviewText(
			lines,
			true,
			theme,
			previewLimit(),
			lines.length,
			(line) => theme.fg(ctx.isError ? "error" : "dim", line || " "),
		);
	return makeText(ctx.lastComponent, withBranch(`${statusText}\n${preview}`, theme));
}

// ===========================================================================
// Extension
// ===========================================================================

export default function (pi: ExtensionAPI) {
	patchTerminalWriteTagScrubber();
	patchToolExecutionBackgroundSync();
	patchToolRenderCacheInvalidation();
	patchReadImageExpansion();
	patchContainerParentTracking();
	patchGlobalToolBorders();
	patchCustomMessageRender();
	patchAssistantMessages();
	patchToolExecutionRenderers();
	applyDiffPalette();
	registerThinkingLevelTracking(pi);
	registerThinkingLabels(pi);
	syncExtraToolDetailMode();

	pi.registerShortcut("ctrl+shift+o", {
		description: "Toggle extra tool output detail",
		handler: async (ctx) => {
			setExtraToolDetailMode(!extraToolOutputExpanded);
			if (ctx.hasUI) {
				ctx.ui.setToolsExpanded(ctx.ui.getToolsExpanded());
				ctx.ui.notify(`Extra tool detail: ${extraToolOutputExpanded ? "on" : "off"}`, "info");
			}
		},
	});

	// /cc-tools command — control tool chrome, grouping, and detail level.
	const TOOL_MODES = ["outlines", "transparent", "default"] as const;
	const TOOL_BOOL_MODES = ["on", "off", "toggle", "status"] as const;
	const TOOL_SUBCOMMANDS = [...TOOL_MODES, "group", "detail", "activity", "shimmer", "pending", "thinking", "branch", "status"] as const;
	const booleanMode = (raw: string | undefined, current: boolean): boolean | "status" | undefined => {
		const mode = raw || "toggle";
		if (mode === "on") return true;
		if (mode === "off") return false;
		if (mode === "toggle") return !current;
		if (mode === "status") return "status";
		return undefined;
	};
	const notifyToolStatus = (ctx: any): void => {
		if (!ctx.hasUI) return;
		const branchMode = toolBranchColorModeFixed() ? "fixed" : "theme";
		const branchGray = getConfiguredToolBranchGray();
		const theme = ctx.ui?.theme;
		const chromeHint = branchMode === "theme" && theme
			? (resolveThemeChromeFg(theme) ? " (attenuated on light themes)" : " (fallback gray if theme keys missing)")
			: "";
		const branchLine = branchMode === "fixed"
			? `Branch color: fixed rgb(${branchGray})`
			: `Branch color: theme${chromeHint}`;
		ctx.ui.notify([
			`Tool style: ${toolBackgroundMode}`,
			`Tool grouping: ${toolGroupingEnabled() ? "on" : "off"}`,
			`Activity labels: ${activityGroupsEnabled() ? "on" : "off"} · param ${toolActivityParamEnabled() ? "on" : "off"} · shimmer ${activityShimmerEnabled() ? "on" : "off"} · pending ${pendingIndicatorMode()}`,
			`Thinking: ${getThinkingMode()}`,
			`Extra detail: ${extraToolOutputExpanded ? "on" : "off"} (${rawKeyHint("ctrl+shift+o", "toggle")})`,
			branchLine,
			`  /cc-tools branch <0-255> | theme | fixed | reset`,
		].join("\n"), "info");
	};
	pi.registerCommand("cc-tools", {
		description: "Control tool UI: style, grouped rows, and Ctrl+Shift+O extra-detail mode",
		getArgumentCompletions(prefix) {
			const parts = prefix.trimStart().split(/\s+/);
			const first = parts[0] ?? "";
			if (parts.length <= 1) {
				return TOOL_SUBCOMMANDS
					.filter((m) => m.startsWith(first))
					.map((m) => ({
						value: m,
						label: m,
						description:
							m === "group" ? "Toggle grouped adjacent/concurrent tool rows"
							: m === "activity" ? "Toggle the activity label on tool calls"
							: m === "shimmer" ? "Toggle the highlight sweep on running group labels"
							: m === "pending" ? "Per-call pending light: circle-breathe (default), braille spinner, or blinking dot (group headers stay steady)"
							: m === "thinking" ? "Thinking display: live (default) or full"
							: m === "detail" ? "Toggle Ctrl+Shift+O extra-detail mode"
							: m === "branch" ? "├ ╰ │ gray (0-255), theme, fixed, or reset"
							: m === "status" ? "Show tool UI settings"
							: m === "outlines" ? "Horizontal rules around each tool (default)"
							: m === "transparent" ? "No borders or backgrounds"
							: "Pi built-in tool backgrounds",
					}));
			}
			if (first === "branch") {
				const second = parts[1] ?? "";
				const opts = ["theme", "fixed", "reset", "status"];
				return opts
					.filter((o) => o.startsWith(second))
					.map((o) => ({ value: `branch ${o}`, label: o, description: "Branch connector color" }));
			}
			if (first === "pending") {
				const second = parts[1] ?? "";
				return ["breathe", "spinner", "dot", "status"]
					.filter((m) => m.startsWith(second))
					.map((m) => ({ value: `pending ${m}`, label: m, description: `${m} pending light` }));
			}
			if (first === "thinking") {
				const second = parts[1] ?? "";
				return ["live", "full", "status"]
					.filter((m) => m.startsWith(second))
					.map((m) => ({ value: `thinking ${m}`, label: m, description: `${m} thinking display` }));
			}
			if (first === "group" || first === "detail" || first === "extra" || first === "activity" || first === "shimmer") {
				const second = parts[1] ?? "";
				return TOOL_BOOL_MODES
					.filter((m) => m.startsWith(second))
					.map((m) => ({ value: `${first} ${m}`, label: m, description: `${m} ${first}` }));
			}
			return [];
		},
		async handler(args, ctx) {
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "";
			if (!sub || sub === "status") {
				notifyToolStatus(ctx);
				return;
			}

			if (sub === "group") {
				const next = booleanMode(parts[1], toolGroupingEnabled());
				if (next === undefined) {
					if (ctx.hasUI) ctx.ui.notify(`Usage: /cc-tools group ${TOOL_BOOL_MODES.join("|")}`, "error");
					return;
				}
				if (next === "status") {
					if (ctx.hasUI) ctx.ui.notify(`Tool grouping: ${toolGroupingEnabled() ? "on" : "off"}`, "info");
					return;
				}
				setToolGroupingEnabled(next);
				if (ctx.hasUI) {
					ctx.ui.setToolsExpanded(ctx.ui.getToolsExpanded());
					ctx.ui.notify(`Tool grouping: ${next ? "on" : "off"}${next ? " (future adjacent tool rows)" : ""}`, "info");
				}
				return;
			}

			if (sub === "activity") {
				const next = booleanMode(parts[1], toolActivityParamEnabled());
				if (next === undefined) {
					if (ctx.hasUI) ctx.ui.notify(`Usage: /cc-tools activity ${TOOL_BOOL_MODES.join("|")}`, "error");
					return;
				}
				if (next === "status") {
					if (ctx.hasUI) ctx.ui.notify(`Activity param: ${toolActivityParamEnabled() ? "on" : "off"}`, "info");
					return;
				}
				writeSettingsKey("toolActivityParam", next);
				reregisterCoreTools(pi);
				if (ctx.hasUI) {
					ctx.ui.notify(
						next
							? "Activity param: on — the model labels every core tool call"
							: "Activity param: off — labels fall back to the previous group",
						"info",
					);
				}
				return;
			}

			if (sub === "shimmer") {
				const next = booleanMode(parts[1], activityShimmerEnabled());
				if (next === undefined) {
					if (ctx.hasUI) ctx.ui.notify(`Usage: /cc-tools shimmer ${TOOL_BOOL_MODES.join("|")}`, "error");
					return;
				}
				if (next === "status") {
					if (ctx.hasUI) ctx.ui.notify(`Label shimmer: ${activityShimmerEnabled() ? "on" : "off"}`, "info");
					return;
				}
				writeSettingsKey("activityShimmer", next);
				if (ctx.hasUI) refreshAllToolBranchVisuals(ctx);
				if (ctx.hasUI) {
					ctx.ui.notify(
						next
							? "Label shimmer: on — running groups sweep a highlight across the activity label"
							: "Label shimmer: off — activity labels keep a constant color",
						"info",
					);
				}
				return;
			}

			if (sub === "pending") {
				const arg = parts[1] ?? "status";
				if (arg === "status") {
					if (ctx.hasUI) ctx.ui.notify(`Pending light: ${pendingIndicatorMode()}`, "info");
					return;
				}
				if (arg !== "breathe" && arg !== "spinner" && arg !== "dot") {
					if (ctx.hasUI) ctx.ui.notify(`Usage: /cc-tools pending breathe|spinner|dot|status`, "error");
					return;
				}
				writeSettingsKey("pendingIndicator", arg === "breathe" ? undefined : arg);
				if (ctx.hasUI) refreshAllToolBranchVisuals(ctx);
				if (ctx.hasUI) {
					ctx.ui.notify(
						arg === "dot"
							? "Pending light: dot — the classic blinking ●"
							: arg === "spinner"
								? `Pending light: spinner — ${SPINNER_FRAMES.join("")}`
								: "Pending light: breathe — ● • · · • ",
						"info",
					);
				}
				return;
			}

			if (sub === "branch") {
				const arg = parts[1] ?? "status";
				if (arg === "status" || !arg) {
					notifyToolStatus(ctx);
					return;
				}
				if (arg === "reset") {
					writeSettingsKey("toolBranchRgbGray", undefined);
					writeSettingsKey("toolBranchColorMode", undefined);
					if (ctx.hasUI) refreshAllToolBranchVisuals(ctx);
					if (ctx.hasUI) ctx.ui.notify(`Branch color → fixed rgb(${DEFAULT_TOOL_BRANCH_GRAY}) (default)`, "info");
					return;
				}
				if (arg === "theme") {
					writeSettingsKey("toolBranchColorMode", "theme");
					if (ctx.hasUI) refreshAllToolBranchVisuals(ctx);
					if (ctx.hasUI) ctx.ui.notify("Branch color → follow pi theme (dim/muted)", "info");
					return;
				}
				if (arg === "fixed") {
					writeSettingsKey("toolBranchColorMode", "fixed");
					if (ctx.hasUI) refreshAllToolBranchVisuals(ctx);
					if (ctx.hasUI) ctx.ui.notify(`Branch color → fixed rgb(${getConfiguredToolBranchGray()})`, "info");
					return;
				}
				const gray = Number.parseInt(arg, 10);
				if (!Number.isFinite(gray) || gray < 0 || gray > 255) {
					if (ctx.hasUI) ctx.ui.notify("Usage: /cc-tools branch <0-255> | theme | fixed | reset", "error");
					return;
				}
				writeSettingsKey("toolBranchRgbGray", gray);
				writeSettingsKey("toolBranchColorMode", "fixed");
				if (ctx.hasUI) refreshAllToolBranchVisuals(ctx);
				if (ctx.hasUI) ctx.ui.notify(`Branch color → fixed rgb(${gray})`, "info");
				return;
			}

			if (sub === "thinking") {
				const arg = (parts[1] ?? "status").toLowerCase();
				if (arg === "status" || !arg) {
					if (ctx.hasUI) ctx.ui.notify(`Thinking: ${getThinkingMode()} (live = only streaming thinking expands; full = always expanded)`, "info");
					return;
				}
				if (arg !== "live" && arg !== "full") {
					if (ctx.hasUI) ctx.ui.notify("Usage: /cc-tools thinking live|full|status", "error");
					return;
				}
				writeSettingsKey("thinkingMode", arg);
				if (ctx.hasUI) {
					ctx.ui.setToolsExpanded(ctx.ui.getToolsExpanded());
					ctx.ui.notify(`Thinking → ${arg}${arg === "live" ? " (only the active thinking expands)" : " (thinking always expanded)"}`, "info");
				}
				return;
			}

			if (sub === "detail" || sub === "extra") {
				const next = booleanMode(parts[1], extraToolOutputExpanded);
				if (next === undefined) {
					if (ctx.hasUI) ctx.ui.notify(`Usage: /cc-tools detail ${TOOL_BOOL_MODES.join("|")}`, "error");
					return;
				}
				if (next === "status") {
					if (ctx.hasUI) ctx.ui.notify(`Extra tool detail: ${extraToolOutputExpanded ? "on" : "off"}`, "info");
					return;
				}
				setExtraToolDetailMode(next);
				if (ctx.hasUI) {
					ctx.ui.setToolsExpanded(ctx.ui.getToolsExpanded());
					ctx.ui.notify(`Extra tool detail: ${extraToolOutputExpanded ? "on" : "off"}`, "info");
				}
				return;
			}

			if (!(TOOL_MODES as readonly string[]).includes(sub)) {
				if (ctx.hasUI) ctx.ui.notify(`Unknown option "${sub}". Try /cc-tools status, /cc-tools thinking live, /cc-tools group toggle, /cc-tools activity toggle, /cc-tools shimmer toggle, or /cc-tools pending spinner.`, "error");
				return;
			}
			toolBackgroundOverride = sub as typeof toolBackgroundMode;
			toolBackgroundMode = toolBackgroundOverride;
			writeSettingsKey("toolBackground", sub);
			if (ctx.hasUI) {
				applyToolBackgroundMode(ctx.ui.theme);
				ctx.ui.notify(`Tool style → ${sub}`, "info");
			}
		},
	});

	// /cc-theme command — toggle pi-theme-adaptive coloring at runtime.
	const THEME_MODES = ["on", "off", "toggle", "status"] as const;
	pi.registerCommand("cc-theme", {
		description: "Toggle whether tool borders / branch rules / diff colors follow the active pi theme",
		getArgumentCompletions(prefix) {
			return THEME_MODES
				.filter((m) => m.startsWith(prefix))
				.map((m) => ({
					value: m,
					label: m,
					description:
						m === "on" ? "Derive borders, branch rules, dim text and diff tints from the active pi theme (default)"
						: m === "off" ? "Keep the fixed Claude-style palette regardless of theme"
						: m === "toggle" ? "Flip between on and off"
						: "Show the current setting and a preview of the derived colors",
				}));
		},
		async handler(args, ctx) {
			const raw = args.trim().toLowerCase();
			const current = themeAdaptiveEnabled();

			if (!raw || raw === "status") {
				if (!ctx.hasUI) return;
				const theme = ctx.ui.theme as any;
				const themeName = theme?.name ?? "unknown";
				const state = current ? "on" : "off";
				if (raw === "status" && current) {
					const chromePreview = resolveThemeChromeFg(theme);
					// Print a short preview of what we derived.
					const preview = [
						`chrome      : ${chromePreview ? `${chromePreview}─┌ ├─\x1b[39m` : "(unchanged)"}`,
						`  (tool rules, branches)`,
						`muted text  : ${safeFgAnsi(theme, "muted") ? `${safeFgAnsi(theme, "muted")}example dim text\x1b[39m` : "(unchanged)"}`,
						`diff add    : ${safeFgAnsi(theme, "toolDiffAdded") ? `${safeFgAnsi(theme, "toolDiffAdded")}+ added line\x1b[39m` : "(unchanged)"}`,
						`diff del    : ${safeFgAnsi(theme, "toolDiffRemoved") ? `${safeFgAnsi(theme, "toolDiffRemoved")}- removed line\x1b[39m` : "(unchanged)"}`,
					].join("\n  ");
					ctx.ui.notify(`Theme adaptive: ${state} (theme "${themeName}")\n  ${preview}`, "info");
				} else {
					ctx.ui.notify(`Theme adaptive: ${state} (theme "${themeName}")`, "info");
				}
				return;
			}

			let next: boolean;
			if (raw === "on") next = true;
			else if (raw === "off") next = false;
			else if (raw === "toggle") next = !current;
			else {
				if (ctx.hasUI) ctx.ui.notify(`Unknown option "${raw}". Options: ${THEME_MODES.join(", ")}`, "error");
				return;
			}

			writeSettingsKey("themeAdaptive", next);
			// Invalidate caches so the next render re-derives from the active
			// theme (or falls back to the fixed Claude palette).
			invalidateThemePaletteCache();
			autoDerivePending = true;
			if (next) {
				if (ctx.hasUI) applyThemePaletteIfNeeded(ctx.ui.theme);
			} else {
				resetThemePalette();
			}
			if (ctx.hasUI) {
				const label = next ? "on — colors follow pi theme" : "off — fixed Claude palette";
				ctx.ui.notify(`Theme adaptive: ${label}`, "info");
			}
		},
	});

	pi.on("session_start", async (event, ctx) => {
		clearRtkRewriteState();
		if (!ctx.hasUI) return;
		patchUiNotifications(ctx.ui);
		// Session switch (/resume, /new) can leave tool chrome from the previous
		// theme; rebind from ctx.ui.theme (other extensions may setTheme in the
		// same tick — deferred passes pick up the final theme without coupling).
		rebindUiChromeToTheme(ctx);
		scheduleDeferredChromeRebind(ctx, 0);
		const reason = (event as { reason?: string })?.reason;
		if (reason === "resume" || reason === "new" || reason === "fork") {
			scheduleDeferredChromeRebind(ctx, 48);
			// Chat history rebuild can run after session_start; re-sync transparent tool bgs.
			scheduleDeferredChromeRebind(ctx, 120);
		}
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		patchUiNotifications(ctx.ui);
		applyToolBackgroundMode(ctx.ui.theme);
		applyThemePaletteIfNeeded(ctx.ui.theme);
	});

	pi.on("message_update", async (event) => {
		const content = (event as any)?.message?.content;
		const hasText = Array.isArray(content) && content.some((block: any) => block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0);
		if (hasText) clearPreservedBashPreviews();
	});

	pi.on("tool_execution_start", async (event) => {
		clearPreservedBashPreviews();
		recordToolStart((event as any)?.toolCallId);
		const toolName = (event as any)?.toolName;
		if (toolName !== "bash") return;
		trackRtkOriginalBashCommand((event as any)?.toolCallId, (event as any)?.args);
	});

	const cwd = process.cwd();
	const sp = (path: string) => shortPath(cwd, path);

	// Advertise the opt-in activity integration and start tracking activity before
	// any tool registers or a run starts.
	registerActivityApi(pi);

	const readTool = createReadTool(cwd);
	registerCoreTool(pi, "read", () => ({
		name: "read",
		label: "read",
		description: readTool.description,
		parameters: readTool.parameters,
		async execute(toolCallId, params, signal, onUpdate) {
			return readTool.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, ctx) {
			syncToolCallStatus(ctx);
			// SKILL.md reads: render as [skill] block matching /skill:name style
			const rawPath = String(args?.path ?? "");
			const absPath = resolve(ctx.cwd ?? cwd, rawPath);
			if (basename(absPath) === "SKILL.md") {
				const skillName = basename(dirname(absPath)) || "SKILL.md";
				const line =
					theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
					theme.fg("customMessageText", skillName);
				return makeText(ctx.lastComponent, `${toolStatusDot(ctx, theme)}${line}${liveLineCountTrailing(ctx, theme)}`);
			}
			const summary = stableCallSummary(ctx, "_callSummary", () => {
				let value = sp(args.path ?? "");
				if (args.offset || args.limit) {
					const parts: string[] = [];
					if (args.offset) parts.push(`offset=${args.offset}`);
					if (args.limit) parts.push(`limit=${args.limit}`);
					value += ` ${theme.fg("muted", `(${parts.join(", ")})`)}`;
				}
				return value;
			});
			return makeText(
				ctx.lastComponent,
				toolHeader("read", summary, theme, toolStatusDot(ctx, theme), liveLineCountTrailing(ctx, theme)),
			);
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			if (isPartial) {
				return makeText(ctx.lastComponent, runningPreviewBlock(result, theme.fg("dim", "Reading..."), expanded, theme, ctx));
			}
			clearBlinkTimer(ctx);
			setToolStatus(ctx, ctx.isError ? "error" : "success");
			if (getFirstImageBlock(result)) return renderReadImageResult(result, expanded, theme, ctx);
			const details = result.details as ReadToolDetails | undefined;
			const content = result.content.find((block: any) => block?.type === "text");
			if (content?.type !== "text") return makeText(ctx.lastComponent, withBranch(theme.fg("error", "No text content"), theme));
			const lines = content.text.split("\n");
			let text = theme.fg("muted", `${lines.length} lines loaded`);
			if (details?.truncation?.truncated) text += theme.fg("warning", " (truncated)");
			if (!expanded) return makeText(ctx.lastComponent, withBranch(`${text}${toolOutputDetailHint(theme, expanded)}`, theme));
			text += `\n${buildPreviewText(lines, false, theme, previewLimit(), lines.length, (line) => theme.fg("dim", line || " "))}`;
			return makeText(ctx.lastComponent, withBranch(text, theme));
		},
	}));

	const bashTool = createBashTool(cwd);
	registerCoreTool(pi, "bash", () => ({
		name: "bash",
		label: "bash",
		description: bashTool.description,
		parameters: bashTool.parameters,
		async execute(toolCallId, params, signal, onUpdate) {
			return bashTool.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, ctx) {
			syncToolCallStatus(ctx);
			syncBashDuration(ctx);
			const rewrite = ensureRtkRewriteForContext(ctx, args);
			const command = typeof args.command === "string" ? args.command : "";
			const presentation = buildBashCommandPresentation(command);
			const summary = stableCallSummary(ctx, "_bashHeadline", () => presentation.headline);
			const rtkBadge = rewrite ? theme.fg("muted", " (RTK)") : "";
			const status = ctx?.state?._toolStatus;
			const showCommand = ctx.argsComplete === true && (status === "pending" || status === "error" || ctx.expanded === true);
			const commandBlock = showCommand ? renderBashCommandBlock(command, ctx.expanded === true, theme) : "";
			const headerSummary = ctx.expanded === true && commandBlock ? describeBashSource(presentation) : summary;
			const header = toolHeader(
				"bash",
				`${headerSummary}${rtkBadge}`,
				theme,
				toolStatusDot(ctx, theme),
				bashHeaderTrailing(ctx, theme),
			).replace(WRAP_MARK, CLIP_MARK);
			return makeText(ctx.lastComponent, commandBlock ? `${header}\n${commandBlock}` : header);
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			syncBashDuration(ctx, isPartial);
			const details = result.details as BashToolDetails | undefined;
			const rewrite = ensureRtkRewriteForContext(ctx, ctx.args);
			const output = result.content[0]?.type === "text" ? result.content[0].text : "";
			if (isPartial) {
				const preview = collectNonEmptyLines(output, expanded ? undefined : liveToolPreviewLimit());
				const running = runningPreviewBlock(result, "", expanded, theme, ctx, {
					lines: preview.lines,
					totalLineCount: preview.total,
					styleLine: (line) => theme.fg("dim", line),
					tail: true,
				});
				const withRewrite = expanded && rewrite
					? [running, withBranch(formatRtkRewriteDetails(rewrite, theme), theme)].filter(Boolean).join("\n")
					: running;
				return makeText(ctx.lastComponent, withRewrite);
			}
			// Collapsed: only keep the live-preview tail (or nothing). Expanded: full list.
			const keepTail = !expanded && liveToolPreviewEnabled() ? liveToolPreviewLimit() : undefined;
			const nonEmpty = collectNonEmptyLines(output, expanded ? undefined : (keepTail ?? 0));
			clearBlinkTimer(ctx);
			setToolStatus(ctx, ctx.isError ? "error" : "success");
			if (nonEmpty.total > 0 && ctx.state?._bashPreviewReleased !== true) {
				preserveBashPreview(ctx);
				if (ctx.state) ctx.state._bashPreviewReleased = true;
			}
			const exitMatch = output.match(/exit code: (\d+)/);
			const exitCode = exitMatch ? Number.parseInt(exitMatch[1], 10) : null;
			let text = exitCode === null || exitCode === 0 ? theme.fg("success", "Done") : theme.fg("error", `Exit ${exitCode}`);
			text += theme.fg("muted", ` (${nonEmpty.total} lines)`);
			if (details?.truncation?.truncated) text += theme.fg("warning", " [truncated]");
			const persistentPreview = shouldPreserveBashPreview(ctx) ? buildPersistentBashPreview(nonEmpty.lines, theme) : "";
			if (!expanded && persistentPreview) return makeText(ctx.lastComponent, withBranch(`${text}${toolOutputDetailHint(theme, expanded)}\n${persistentPreview}`, theme));
			if (!expanded && nonEmpty.total > 0) return makeText(ctx.lastComponent, withBranch(`${text}${toolOutputDetailHint(theme, expanded)}`, theme));
			if (!expanded) return makeText(ctx.lastComponent, withBranch(text, theme));
			const collapsed = bashCollapsedLimit();
			if (rewrite) text += `\n${formatRtkRewriteDetails(rewrite, theme)}`;
			text += `\n${buildPreviewText(nonEmpty.lines, false, theme, collapsed, nonEmpty.total, (line) => theme.fg("dim", line))}`;
			return makeText(ctx.lastComponent, withBranch(text, theme));
		},
	}));

	const grepTool = createGrepTool(cwd);
	registerCoreTool(pi, "grep", () => ({
		name: "grep",
		label: "grep",
		description: grepTool.description,
		parameters: grepTool.parameters,
		async execute(toolCallId, params, signal, onUpdate) {
			return grepTool.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, ctx) {
			syncToolCallStatus(ctx);
			const summary = stableCallSummary(ctx, "_callSummary", () => {
				let value = `\"${summarizeText(args.pattern, 40)}\"`;
				if (args.path) value += ` in ${args.path}`;
				return value;
			});
			return makeText(
				ctx.lastComponent,
				toolHeader("grep", summary, theme, toolStatusDot(ctx, theme), liveLineCountTrailing(ctx, theme)),
			);
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			if (isPartial) {
				return makeText(ctx.lastComponent, runningPreviewBlock(result, theme.fg("dim", "Searching..."), expanded, theme, ctx));
			}
			clearBlinkTimer(ctx);
			setToolStatus(ctx, ctx.isError ? "error" : "success");
			const details = result.details as GrepToolDetails | undefined;
			const matches = (result.content[0]?.type === "text" ? result.content[0].text : "")
				.split("\n")
				.filter((line) => line.trim().length > 0);
			if (matches.length === 0) return makeText(ctx.lastComponent, withBranch(theme.fg("muted", "no matches"), theme));
			let text = theme.fg("muted", `${matches.length} matches`);
			if (details?.truncation?.truncated) text += theme.fg("warning", " (truncated)");
			if (!expanded) return makeText(ctx.lastComponent, withBranch(`${text}${toolOutputDetailHint(theme, expanded)}`, theme));
			text += `\n${buildPreviewText(matches, false, theme, previewLimit(), matches.length, (line) => theme.fg("dim", line))}`;
			return makeText(ctx.lastComponent, withBranch(text, theme));
		},
	}));

	const findTool = createFindTool(cwd);
	registerCoreTool(pi, "find", () => ({
		name: "find",
		label: "find",
		description: findTool.description,
		parameters: findTool.parameters,
		async execute(toolCallId, params, signal, onUpdate) {
			return findTool.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, ctx) {
			syncToolCallStatus(ctx);
			const summary = stableCallSummary(ctx, "_callSummary", () => {
				let value = `\"${summarizeText(args.pattern, 40)}\"`;
				if (args.path) value += ` in ${args.path}`;
				return value;
			});
			return makeText(
				ctx.lastComponent,
				toolHeader("find", summary, theme, toolStatusDot(ctx, theme), liveLineCountTrailing(ctx, theme)),
			);
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			if (isPartial) {
				return makeText(ctx.lastComponent, runningPreviewBlock(result, theme.fg("dim", "Finding..."), expanded, theme, ctx));
			}
			clearBlinkTimer(ctx);
			setToolStatus(ctx, ctx.isError ? "error" : "success");
			const items = (result.content[0]?.type === "text" ? result.content[0].text : "")
				.split("\n")
				.filter((line) => line.trim().length > 0);
			if (items.length === 0) return makeText(ctx.lastComponent, withBranch(theme.fg("muted", "no files found"), theme));
			let text = theme.fg("muted", `${items.length} files`);
			if (!expanded) return makeText(ctx.lastComponent, withBranch(`${text}${toolOutputDetailHint(theme, expanded)}`, theme));
			// Expanded: grouped find results with icons
			const maxShow = previewLimit();
			const shown = items.slice(0, maxShow);
			const findLines: string[] = [];
			for (let i = 0; i < shown.length; i++) {
				const item = shown[i].trim();
				const icon = fileIcon(item);
				findLines.push(`  ${icon}${theme.fg("dim", item)}`);
			}
			const remaining = items.length - shown.length;
			if (remaining > 0) {
				findLines.push(`  ${theme.fg("muted", `… ${remaining} more files`)}`);
			}
			text += `\n${findLines.join('\n')}`;
			return makeText(ctx.lastComponent, withBranch(text, theme));
		},
	}));

	const lsTool = createLsTool(cwd);
	registerCoreTool(pi, "ls", () => ({
		name: "ls",
		label: "ls",
		description: lsTool.description,
		parameters: lsTool.parameters,
		async execute(toolCallId, params, signal, onUpdate) {
			return lsTool.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, ctx) {
			syncToolCallStatus(ctx);
			const summary = stableCallSummary(ctx, "_callSummary", () => sp(args.path ?? "."));
			return makeText(
				ctx.lastComponent,
				toolHeader("ls", summary, theme, toolStatusDot(ctx, theme), liveLineCountTrailing(ctx, theme)),
			);
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			if (isPartial) {
				return makeText(ctx.lastComponent, runningPreviewBlock(result, theme.fg("dim", "Listing..."), expanded, theme, ctx));
			}
			clearBlinkTimer(ctx);
			setToolStatus(ctx, ctx.isError ? "error" : "success");
			const items = (result.content[0]?.type === "text" ? result.content[0].text : "")
				.split("\n")
				.filter((line) => line.trim().length > 0);
			if (items.length === 0) return makeText(ctx.lastComponent, withBranch(theme.fg("muted", "empty directory"), theme));
			let text = theme.fg("muted", `${items.length} entries`);
			if (!expanded) return makeText(ctx.lastComponent, withBranch(`${text}${toolOutputDetailHint(theme, expanded)}`, theme));
			// Expanded: tree-view with icons
			const maxShow = previewLimit();
			const shown = items.slice(0, maxShow);
			const treeLines: string[] = [];
			for (let i = 0; i < shown.length; i++) {
				const item = shown[i];
				const isDir = item.endsWith("/");
				const isLast = i === shown.length - 1 && items.length <= maxShow;
				const prefix = isLast ? `${FG_RULE}\u2514\u2500\u2500${D_RST} ` : `${FG_RULE}\u251c\u2500\u2500${D_RST} `;
				const icon = isDir ? dirIcon() : fileIcon(item);
				const name = isDir ? theme.fg("accent", theme.bold(item)) : theme.fg("dim", item);
				treeLines.push(`${prefix}${icon}${name}`);
			}
			const remaining = items.length - shown.length;
			if (remaining > 0) {
				treeLines.push(`${FG_RULE}\u2514\u2500\u2500${D_RST} ${theme.fg("muted", `\u2026 ${remaining} more entries`)}`);
			}
			text += `\n${treeLines.join('\n')}`;
			return makeText(ctx.lastComponent, withBranch(text, theme));
		},
	}));

	const writeTool = createWriteTool(cwd);
	registerCoreTool(pi, "write", () => ({
		name: "write",
		label: "write",
		description: writeTool.description,
		parameters: writeTool.parameters,
		async execute(toolCallId, params, signal, onUpdate, _ctx) {
			const fp = params.path ?? (params as any).file_path ?? "";
			const fullPath = fp ? resolve(cwd, fp) : "";
			const existedBefore = !!fullPath && fileExistsForTool(cwd, fp);
			WRITE_EXISTED_BEFORE.set(toolCallId, existedBefore);
			let old: string | null = null;
			try {
				if (fullPath && existedBefore) old = readFileSync(fullPath, "utf-8");
			} catch {
				old = null;
			}
			WRITE_CONTENT_BEFORE.set(toolCallId, old ?? undefined);
			const result = await writeTool.execute(toolCallId, params, signal, onUpdate);
			const content = params.content ?? "";
			if (old !== null && old !== content) {
				const diff = parseDiff(old, content);
				(result as any).details = { _type: "diff", summary: summarizeDiff(diff.added, diff.removed), diff, language: lang(fp) };
			} else if (old === null) {
				(result as any).details = { _type: "new", lines: lineCount(content), filePath: fp };
			} else if (old === content) {
				(result as any).details = { _type: "noChange" };
			}
			return result;
		},
		renderCall(args, theme, ctx) {
			const fp = args?.path ?? (args as any)?.file_path ?? "";
			const revealSummary = shouldRevealCallArgs(ctx) || (!!fp && hasOwnArg(args, "content"));
			syncToolCallStatus(ctx);
			const wasNew = getWriteWasNewFile(ctx, cwd, fp, revealSummary);
			const label = "write";
			const summary = stableCallSummary(ctx, "_callSummary", () => {
				const base = sp(fp);
				return shouldRevealCallArgs(ctx) ? `${base} ${theme.fg("muted", `(${lineCount(args.content ?? "")} lines)`)}` : base;
			}, revealSummary);
			const hdr = toolHeader(label, summary, theme, toolStatusDot(ctx, theme), liveLineCountTrailing(ctx, theme));
			const content = typeof args?.content === "string" ? args.content : undefined;
			if (!(ctx.argsComplete && ctx.isPartial && fp && content !== undefined)) {
				return makeText(ctx.lastComponent, hdr);
			}
			const baseline = getPendingWriteBaseline(ctx, cwd, fp);
			if (baseline.notice) {
				const notice = indentBranchBlock(withBranch(theme.fg("warning", baseline.notice), theme, false, true));
				return makeText(ctx.lastComponent, `${hdr}\n${notice}`);
			}
			const diffWidth = contextDiffWidth(ctx);
			const key = `pending-write:${fp}:${hashText(baseline.content ?? "")}:${hashText(content)}:${diffWidth}:${ctx.expanded ? 1 : 0}`;
			if (ctx.state._pendingWritePreviewKey !== key) {
				ctx.state._pendingWritePreviewKey = key;
				// No placeholder: the builder publishes an unhighlighted body synchronously and then
				// upgrades it to the highlighted one, which has the same rows (see renderUnifiedRows).
				renderPendingWritePreviewBody(ctx, key, theme, fp, baseline.content ?? "", content, baseline.existed);
			}
			const body = ctx.state._pendingWritePreviewDisplay as string | undefined;
			return makeResponsiveDiffText(ctx, ctx.lastComponent, body ? `${hdr}\n${body}` : hdr);
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			if (isPartial) {
				return makeText(ctx.lastComponent, runningPreviewBlock(result, "", expanded, theme, ctx));
			}
			clearBlinkTimer(ctx);
			setToolStatus(ctx, ctx.isError ? "error" : "success");
			if (typeof ctx?.toolCallId === "string") {
				WRITE_EXISTED_BEFORE.delete(ctx.toolCallId);
				WRITE_CONTENT_BEFORE.delete(ctx.toolCallId);
			}
			if (ctx.isError) {
				const e =
					result.content
						?.filter((c: any) => c.type === "text")
						.map((c: any) => c.text || "")
						.join("\n") ?? "Error";
				return makeText(ctx.lastComponent, withBranch(theme.fg("error", e), theme));
			}
			const d = (result as any).details;
			if (d?._type === "diff") {
				const previewLines = ctx.expanded ? MAX_RENDER_LINES : diffCollapsedLimit();
				const hunks = d.diff?.lines?.filter((l: any) => l.type === "sep").length + (d.diff?.lines?.length ? 1 : 0);
				const diffWidth = contextDiffWidth(ctx);
				const key = `wd:${diffWidth}:${d.summary}:${d.diff?.lines?.length ?? 0}:${d.language ?? ""}:${ctx.expanded ? 1 : 0}`;
				// Sticky per tool result (not per frame): the line count changes while the diff renders.
				const mode = stickyUseSplit(ctx.state, `write-diff:${d.summary ?? ""}:${d.language ?? ""}`, d.diff, diffWidth, previewLines) ? "split" : "unified";
				const richSummary = diffSummaryWithMeta(d.diff.added, d.diff.removed, hunks, mode);
				if (ctx.state._wdk !== key) {
					ctx.state._wdk = key;
					const token = beginDiffPreviewBuild(ctx.state, "_wdToken");
					const dc = resolveDiffColors(theme);
					// Synchronous, unhighlighted first: same rows and height as the highlighted pass below.
					const plainWdt = renderSplitPlain(d.diff, previewLines, dc, diffWidth);
					ctx.state._wdt = withFinalBranchBlock(`${richSummary}\n${plainWdt}`, theme);
					renderDiffBody(plainWdt, d.diff, d.language, previewLines, dc, diffWidth, mode)
						.then((rendered) => {
							if (!isDiffPreviewBuildCurrent(ctx.state, "_wdToken", token)) return;
							ctx.state._wdt = withFinalBranchBlock(`${richSummary}\n${rendered}`, theme);
							safeInvalidate(ctx);
						})
						.catch(() => {
							if (!isDiffPreviewBuildCurrent(ctx.state, "_wdToken", token)) return;
							// Keep a diff that is already on screen: the stat line alone shrinks the row.
							if (!ctx.state._wdt) ctx.state._wdt = withBranch(richSummary, theme);
							safeInvalidate(ctx);
						});
				}
				const wdBody = (ctx.state._wdt as string | undefined) ?? withFinalBranchBlock(`${richSummary}\n${renderSplitPlain(d.diff, previewLines, resolveDiffColors(theme), diffWidth)}`, theme);
				return makeResponsiveDiffText(ctx, ctx.lastComponent, wdBody);
			}
			if (d?._type === "noChange") return makeText(ctx.lastComponent, withBranch(theme.fg("muted", "✓ no changes"), theme));
			if (d?._type === "new") {
				const content = typeof ctx.args?.content === "string" ? ctx.args.content : "";
				const lineTotal = typeof d.lines === "number" ? d.lines : lineCount(content);
				const contentHash = hashText(content);
				const syntheticDiff = getCachedParsedDiff(ctx, `nf-diff:${d.filePath}:${contentHash}`, "", content);
				const richSummary = diffSummaryWithMeta(syntheticDiff.added, 0, 1, "new file");
				const previewLines = ctx.expanded ? MAX_RENDER_LINES : diffCollapsedLimit();
				const diffWidth = contextDiffWidth(ctx);
				const pk = `nf:${d.filePath}:${contentHash}:${diffWidth}:${ctx.expanded ? 1 : 0}`;
				if (ctx.state._nfk !== pk) {
					ctx.state._nfk = pk;
					const token = beginDiffPreviewBuild(ctx.state, "_nfToken");
					const dc = resolveDiffColors(theme);
					// Synchronous, unhighlighted first: same rows and height as the highlighted pass below.
					const plainNft = renderUnifiedPlain(syntheticDiff, previewLines, dc, diffWidth);
					ctx.state._nft = withFinalBranchBlock(`${richSummary}\n${plainNft}`, theme);
					renderDiffBody(plainNft, syntheticDiff, lang(d.filePath), previewLines, dc, diffWidth, "unified")
						.then((rendered) => {
							if (!isDiffPreviewBuildCurrent(ctx.state, "_nfToken", token)) return;
							ctx.state._nft = withFinalBranchBlock(`${richSummary}\n${rendered}`, theme);
							safeInvalidate(ctx);
						})
						.catch(() => {
							if (!isDiffPreviewBuildCurrent(ctx.state, "_nfToken", token)) return;
							// Keep a diff that is already on screen: the stat line alone shrinks the row.
							if (!ctx.state._nft) ctx.state._nft = withBranch(`${richSummary} ${theme.fg("muted", `(${lineTotal} lines)`)}`, theme);
							safeInvalidate(ctx);
						});
				}
				const nfBody = (ctx.state._nft as string | undefined) ?? withFinalBranchBlock(`${richSummary}\n${renderUnifiedPlain(syntheticDiff, previewLines, resolveDiffColors(theme), diffWidth)}`, theme);
				return makeResponsiveDiffText(ctx, ctx.lastComponent, nfBody);
			}
			return makeText(ctx.lastComponent, withBranch(theme.fg("success", "Written"), theme));
		},
	}));

	const editTool = createEditTool(cwd);
	registerCoreTool(pi, "edit", () => ({
		name: "edit",
		label: "edit",
		description: editTool.description,
		parameters: editTool.parameters,
		async execute(toolCallId, params, signal, onUpdate, _ctx) {
			const fp = params.path ?? (params as any).file_path ?? "";
			const operations = getEditOperations(params);
			const [projectedDiff, localizedDiffs] = await Promise.all([
				computeProjectedEditDiff(fp, operations, cwd),
				operations.length === 1 ? computeLocalizedEditDiffs(fp, operations, cwd) : Promise.resolve(null),
			]);
			const result = await editTool.execute(toolCallId, params, signal, onUpdate);
			if (operations.length === 0) return result;
			const { diffs, summary, totalLines, totalHunks } = summarizeEditOperations(operations);
			const baseDetails = (((result as any).details ?? {}) as Record<string, unknown>);
			if (operations.length === 1) {
				const localized = localizedDiffs?.[0];
				const editLine = localized?.line ?? (typeof baseDetails.firstChangedLine === "number" ? baseDetails.firstChangedLine : 0);
				const diff = localized?.diff ?? diffs[0];
				(result as any).details = {
					...baseDetails,
					_type: "editInfo",
					summary,
					editLine,
					hunks: countDiffHunks(diff),
					added: diff?.added ?? 0,
					removed: diff?.removed ?? 0,
					_treeDiff: projectedDiff ?? diff,
				};
				return result;
			}
			(result as any).details = {
				...baseDetails,
				_type: "multiEditInfo",
				summary,
				editCount: operations.length,
				diffLineCount: totalLines,
				hunks: totalHunks,
				totalAdded: diffs.reduce((sum, diff) => sum + diff.added, 0),
				totalRemoved: diffs.reduce((sum, diff) => sum + diff.removed, 0),
				_treeDiff: projectedDiff,
			};
			return result;
		},
		renderCall(args, theme, ctx) {
			const fp = args?.path ?? (args as any)?.file_path ?? "";
			const operations = getEditOperations(args);
			const revealSummary = shouldRevealCallArgs(ctx) || (!!fp && hasOwnArg(args, "edits"));
			const summary = stableCallSummary(ctx, "_callSummary", () => shouldRevealCallArgs(ctx) && operations.length > 1 ? `${sp(fp)} ${theme.fg("muted", `(${operations.length} edits)`)}` : sp(fp), revealSummary);
			syncToolCallStatus(ctx);
			const hdr = toolHeader("edit", summary, theme, ` ${toolStatusDot(ctx, theme)}`, liveLineCountTrailing(ctx, theme));
			if (!(ctx.argsComplete && ctx.isPartial && operations.length > 0)) return makeText(ctx.lastComponent, hdr);
			const diffWidth = contextDiffWidth(ctx);
			const key = `edit:${fp}:${hashText(operations.map((edit) => `${edit.oldText}\u0000${edit.newText}`).join("\u0001"))}:${diffWidth}:${ctx.expanded ? 1 : 0}`;
			const { diffs: fallbackDiffs, summary: editSummary } = getCachedEditOperationSummary(ctx, key, operations);
			if (ctx.state._pk !== key) {
				ctx.state._pk = key;
				// The previous preview stays on screen while this one is built: a one-line
				// placeholder collapses the row and reflows the transcript (see beginDiffPreviewBuild).
				// When the projection can be computed synchronously the row takes its final height on
				// this very frame, unhighlighted; the asynchronous pass below refines the same diff.
				const lg = lang(fp);
				const immediate = computeProjectedEditDiffSync(fp, operations, cwd);
				if (immediate) renderProjectedEditPreviewBody(ctx, key, theme, lg, immediate);
				void computeProjectedEditDiff(fp, operations, cwd)
					.then(async (projectedDiff) => {
						if (ctx.state._pk !== key) return;
						if (projectedDiff) {
							renderProjectedEditPreviewBody(ctx, key, theme, lg, projectedDiff);
							return;
						}
						const localizedDiffs = await computeLocalizedEditDiffs(fp, operations, cwd);
						if (ctx.state._pk !== key) return;
						const diffs = localizedDiffs?.map((entry) => entry.diff) ?? fallbackDiffs;
						renderEditPreviewBody(ctx, key, theme, lg, operations, diffs, editSummary);
					})
					.catch(() => {
						if (ctx.state._pk !== key) return;
						renderEditPreviewBody(ctx, key, theme, lg, operations, fallbackDiffs, editSummary);
					});
			}
			const body = liveBranchDisplay(ctx.state, theme) ?? (ctx.state._ptDisplay as string | undefined);
			if (body) return makeResponsiveDiffText(ctx, ctx.lastComponent, `${hdr}\n${body}`);
			// Nothing rendered yet for this row: the placeholder is the only thing to show.
			return makeResponsiveDiffText(ctx, ctx.lastComponent, `${hdr}\n${indentBranchBlock(withBranch(theme.fg("muted", "(rendering…)"), theme, false, true))}`);
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			if (isPartial) {
				return makeText(ctx.lastComponent, indentBranchBlock(runningPreviewBlock(result, theme.fg("dim", "Editing..."), expanded, theme, ctx)));
			}
			clearBlinkTimer(ctx);
			setToolStatus(ctx, ctx.isError ? "error" : "success");
			if (ctx.isError) {
				const e =
					result.content
						?.filter((c: any) => c.type === "text")
						.map((c: any) => c.text || "")
						.join("\n") ?? "Error";
				return makeText(ctx.lastComponent, indentBranchBlock(withBranch(theme.fg("error", e), theme)));
			}
			const operations = getEditOperations(ctx.args);
			if (operations.length > 0) {
				const fp = ctx.args?.path ?? ctx.args?.file_path ?? "";
				const diffWidth = contextDiffWidth(ctx);
				const operationsHash = hashText(operations.map((edit) => `${edit.oldText}\u0000${edit.newText}`).join("\u0001"));
				const key = `completed-edit:${fp}:${operationsHash}:${diffWidth}:${ctx.expanded ? 1 : 0}`;
				if (ctx.state._pk !== key) {
					ctx.state._pk = key;
					// The previous preview stays on screen while this one is built: a one-line
					// placeholder collapses the row and reflows the transcript (see beginDiffPreviewBuild).
					const projectedDiff = (result as any).details?._treeDiff as ParsedDiff | undefined;
					if (projectedDiff && Array.isArray(projectedDiff.lines)) {
						renderProjectedEditPreviewBody(ctx, key, theme, lang(fp), projectedDiff);
					} else {
						const { diffs, summary } = getCachedEditOperationSummary(ctx, `completed-fallback:${key}`, operations);
						renderEditPreviewBody(
							ctx,
							key,
							theme,
							lang(fp),
							operations,
							diffs,
							summary,
						);
					}
				}
				const body = liveBranchDisplay(ctx.state, theme) ?? (ctx.state._ptDisplay as string | undefined);
				return makeResponsiveDiffText(ctx, ctx.lastComponent, body ?? indentBranchBlock(withBranch(theme.fg("muted", "(rendering diff…)"), theme, false, true)));
			}
			if ((result as any).details?._type === "editInfo") {
				const { editLine, hunks, added, removed } = (result as any).details;
				const loc = formatLineMeta(editLine ?? 0, theme);
				const summary = diffSummaryWithMeta(added ?? 0, removed ?? 0, hunks ?? 0, "");
				return makeText(ctx.lastComponent, indentBranchBlock(withBranch(`${summary}${loc}`, theme)));
			}
			if ((result as any).details?._type === "multiEditInfo") {
				const { editCount, diffLineCount, hunks, totalAdded, totalRemoved } = (result as any).details;
				const summary = diffSummaryWithMeta(totalAdded ?? 0, totalRemoved ?? 0, hunks ?? 0, "");
				return makeText(ctx.lastComponent, indentBranchBlock(withBranch(`${editCount} edits ${summary}${typeof diffLineCount === "number" ? ` ${theme.fg("muted", `(${diffLineCount} diff lines)`)}` : ""}`, theme)));
			}
			return makeText(ctx.lastComponent, indentBranchBlock(withBranch(theme.fg("success", "Applied"), theme)));
		},
	}));

	const wrappedOpenAiTools = new Set<string>();
	const registerOpenAiToolOverrides = (): void => {
		let allTools: unknown[] = [];
		try {
			allTools = typeof (pi as any).getAllTools === "function" ? (pi as any).getAllTools() : [];
		} catch {
			allTools = [];
		}
		for (const tool of allTools) {
			if (!isOpenAiToolCandidate(tool)) continue;
			const record = tool as Record<string, unknown>;
			const name = typeof record.name === "string" ? record.name : "";
			if (!name || wrappedOpenAiTools.has(name)) continue;
			const execute = typeof record.execute === "function" ? (record.execute as any) : null;
			if (!execute) continue;
			const rawLabel = typeof record.label === "string" ? record.label.trim() : "";
			const label = rawLabel && rawLabel !== name && !rawLabel.includes("_") ? rawLabel : name.toLowerCase();
			const description = typeof record.description === "string" ? record.description : label;
			(pi as any).registerTool({
				name,
				label,
				description,
				parameters: record.parameters,
				prepareArguments: typeof record.prepareArguments === "function" ? record.prepareArguments : undefined,
				async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
					return await Promise.resolve(execute(toolCallId, params, signal, onUpdate, ctx));
				},
				renderCall(args: any, theme: Theme, ctx: any) {
					if (name === "apply_patch") return renderApplyPatchCall(args, theme, ctx, sp);
					syncToolCallStatus(ctx);
					ctx.state._openAiPatchFiles = [];
					const summary = stableCallSummary(ctx, "_callSummary", () => summarizeOpenAiToolCall(name, args, theme, sp));
					return makeText(
						ctx.lastComponent,
						toolHeader(label, summary, theme, toolStatusDot(ctx, theme), liveLineCountTrailing(ctx, theme)),
					);
				},
				renderResult(result: any, { expanded, isPartial }: any, theme: Theme, ctx: any) {
					if (name === "apply_patch") return renderApplyPatchResult(result, isPartial, theme, ctx);
					return renderOpenAiToolResult(name, result, expanded, isPartial, theme, ctx);
				},
			});
			wrappedOpenAiTools.add(name);
		}
	};

	const wrappedMcpTools = new Set<string>();
	const registerMcpToolOverrides = (): void => {
		let allTools: unknown[] = [];
		try {
			allTools = typeof (pi as any).getAllTools === "function" ? (pi as any).getAllTools() : [];
		} catch {
			allTools = [];
		}
		for (const tool of allTools) {
			if (!isMcpToolCandidate(tool)) continue;
			const record = tool as Record<string, unknown>;
			const name = typeof record.name === "string" ? record.name : "";
			if (!name || wrappedMcpTools.has(name)) continue;
			const execute = typeof record.execute === "function" ? (record.execute as any) : null;
			if (!execute) continue;
			const label = typeof record.label === "string" ? record.label : name.toLowerCase();
			const description = typeof record.description === "string" ? record.description : "MCP tool";
			(pi as any).registerTool({
				name,
				label,
				description,
				parameters: record.parameters,
				prepareArguments: typeof record.prepareArguments === "function" ? record.prepareArguments : undefined,
				async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
					return await Promise.resolve(execute(toolCallId, params, signal, onUpdate, ctx));
				},
				renderCall(args: any, theme: Theme, ctx: any) {
					return renderGenericToolCall(name, args, theme, ctx);
				},
				renderResult(result: any, { expanded, isPartial }: any, theme: Theme, ctx: any) {
					return renderMcpToolResult(result, expanded, isPartial, theme, ctx);
				},
			});
			wrappedMcpTools.add(name);
		}
	};

	pi.on("session_start", async () => {
		registerOpenAiToolOverrides();
		registerMcpToolOverrides();
	});
	pi.on("before_agent_start", async () => {
		registerOpenAiToolOverrides();
		registerMcpToolOverrides();
	});

	// Streaming activity keeps the blink timer alive. Do NOT clear blink contexts
	// on turn_end — a turn ends when the assistant message finishes, BEFORE its
	// tools run. agent_end / agent_settled are the real "work finished" signals.
	pi.on("turn_start", async () => { markBlinkActivity(); });
	pi.on("message_start", async () => { markBlinkActivity(); });
	pi.on("message_update", async () => { markBlinkActivity(); });
	pi.on("tool_execution_start", async () => { markBlinkActivity(); });
	// Partial tool output is the main long-running signal (bash streams for minutes).
	pi.on("tool_execution_update", async () => { markBlinkActivity(); });
	pi.on("tool_execution_end", async (event) => {
		recordToolEnd((event as any)?.toolCallId);
		markBlinkActivity();
	});
	// agent_end fires when a low-level run finishes (tools for that assistant message
	// are done). registerThinkingLabels clears currentAgentWorkStartMs on the same
	// event; defer so we only wipe blink state once the work marker is gone.
	// Do not use agent_settled here — older peer types don't include it, and the
	// live-agent heartbeat already keeps quiet long tools blinking until agent_end.
	pi.on("agent_end", async () => {
		queueMicrotask(() => {
			if (currentAgentWorkStartMs !== undefined) {
				markBlinkActivity();
				return;
			}
			_clearAllBlinkContexts();
		});
	});
	// Session rebuild (resume/reload/fork) must not leave history partials blinking.
	pi.on("session_start", async () => {
		_clearAllBlinkContexts();
		stopLiveGroupFrame();
	});
	pi.on("session_shutdown", async () => {
		_clearAllBlinkContexts();
		stopLiveGroupFrame();
		clearAllBashDurationContexts();
		clearRtkRewriteState();
		WRITE_EXISTED_BEFORE.clear();
		WRITE_CONTENT_BEFORE.clear();
		clearHighlightCache();
		invalidateThemePaletteCache();
		bumpToolBranchVisualEpoch();
	});
}
