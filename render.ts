import { Text } from "@earendil-works/pi-tui";
import { getRecord, groupMembers, updateRecord, type ToolCallRecord } from "./registry.ts";
import { summarizeCall, summarizeResult, truncate } from "./summarize.ts";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visibleWidth(s: string): number {
	return s.replace(ANSI_RE, "").length;
}

/** Everything the row renderers need to know about one tool definition. */
export interface ToolTreeSpec {
	toolName: string;
	/** Custom call summarizer; falls back to pi-tool-tree's per-tool summary. */
	summarizeCall?: (args: any) => string | undefined;
	/** Custom result summarizer; falls back to pi-tool-tree's per-tool summary. */
	summarizeResult?: (result: any, isError: boolean) => string | undefined;
	/** Original renderers, used when the row is expanded (ctrl+o). */
	originalRenderCall?: ((args: any, theme: any, context: any) => any) | undefined;
	originalRenderResult?: ((result: any, options: any, theme: any, context: any) => any) | undefined;
}

/**
 * renderCall slot: registers this call's summary in the shared registry and
 * returns the tree row component. In collapsed mode the FIRST sibling's row
 * draws the whole group's tree; later siblings' rows render zero lines.
 * In expanded mode (ctrl+o) the original renderer takes over, if any.
 */
export function treeRenderCall(spec: ToolTreeSpec, args: any, theme: any, context: any) {
	const custom = spec.summarizeCall?.(args);
	const callText = custom !== undefined ? custom : summarizeCall(spec.toolName, args);
	updateRecord(context.toolCallId, { toolName: spec.toolName, callText });

	if (context.expanded && spec.originalRenderCall) {
		return spec.originalRenderCall(args, theme, context);
	}
	return new TreeRow(context.toolCallId, theme);
}

/**
 * renderResult slot: records the result suffix/status in the registry
 * (read live by TreeRow on the next frame) and renders nothing in collapsed
 * mode — the group row owns the whole tree. Expanded mode delegates to the
 * original renderer, or falls back to dimmed raw text.
 */
export function treeRenderResult(
	spec: ToolTreeSpec,
	result: any,
	options: { expanded?: boolean },
	theme: any,
	context: any,
) {
	const isError = result?.isError ?? context.isError ?? false;
	const custom = spec.summarizeResult?.(result, isError);
	const suffix = custom !== undefined ? custom : summarizeResult(spec.toolName, result, isError);
	updateRecord(context.toolCallId, { suffix, isError, running: false });

	if (options.expanded) {
		if (spec.originalRenderResult) return spec.originalRenderResult(result, options, theme, context);
		return expandedFallback(result, theme);
	}
	return new Text("", 0, 0);
}

/** Dimmed raw output when a tool has no original renderResult to expand into. */
function expandedFallback(result: any, theme: any): any {
	const content = result?.content;
	const text = Array.isArray(content)
		? content
				.filter((c: any) => c?.type === "text" && c.text)
				.map((c: any) => c.text as string)
				.join("\n")
		: "";
	if (!text) return new Text("", 0, 0);
	const lines = text.split("\n").slice(0, 40).map((line) => theme.fg("toolOutput", line));
	return new Text(lines.join("\n"), 0, 0);
}

/**
 * The tree row. Reads the shared registry at render time so suffixes,
 * statuses, and glyphs stay live without explicit invalidation.
 *
 * When this row is NOT the first member of its sibling group it renders zero
 * lines: the first sibling's row draws the entire group's tree (that's what
 * keeps a parallel batch to a single block with one leading blank line).
 */
class TreeRow {
	private toolCallId: string;
	private theme: any;

	constructor(toolCallId: string, theme: any) {
		this.toolCallId = toolCallId;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const self = getRecord(this.toolCallId);
		const members = self?.groupId ? groupMembers(self.groupId) : self ? [self] : [];
		if (members.length === 0) return [];
		// Only the first sibling draws the group; the rest stay hidden.
		if (members[0].toolCallId !== this.toolCallId) return [];
		return members.map((m, i) => this.memberLine(m, i === members.length - 1, width));
	}

	private memberLine(m: ToolCallRecord, isLast: boolean, width: number): string {
		const theme = this.theme;
		const multi = (m.total ?? 1) > 1;
		const glyph = multi ? (isLast ? "└─" : "├─") : "⎿";
		const status = m.running
			? theme.fg("muted", "…")
			: m.isError
				? theme.fg("error", "✗")
				: theme.fg("dim", "✓");

		// Plain-text layout first so truncation is width-exact, then colorize.
		let name = m.toolName ?? "tool";
		let arg = m.callText ?? summarizeCall(m.toolName ?? "", m.args);
		const suffix = m.suffix ? ` → ${m.suffix}` : "";

		const prefixWidth = 1 + glyph.length + 1 + 1; // " " + glyph + status + " "
		const budget = Math.max(0, width - 1 - prefixWidth);
		// Reserve room for name + separator + suffix; arg gets what's left.
		const fixed = visibleWidth(name) + 1 + suffix.length;
		if (prefixWidth + fixed + arg.length > budget) {
			const argBudget = budget - fixed;
			arg = argBudget > 4 ? truncate(arg, argBudget) : "";
		}
		if (prefixWidth + name.length + 1 + arg.length + suffix.length > budget) {
			const nameBudget = budget - 1 - arg.length - suffix.length;
			name = nameBudget > 2 ? truncate(name, nameBudget) : "";
		}

		const argText = arg ? theme.fg("accent", arg) : "";
		const suffixText = suffix ? theme.fg("dim", suffix) : "";
		return ` ${glyph}${status} ${theme.fg("toolTitle", theme.bold(name))} ${argText}${suffixText}`;
	}
}
