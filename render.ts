import { Text } from "@earendil-works/pi-tui";
import { getRecord, groupMembers, updateRecord, type ToolCallRecord } from "./registry.ts";
import { formatDuration, summarizeCall, summarizeResult, truncate } from "./summarize.ts";


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
	updateRecord(context.toolCallId, { toolName: spec.toolName, callText, treeEnabled: true });

	if (context.expanded) {
		if (spec.originalRenderCall) return spec.originalRenderCall(args, theme, context);
		// Built-ins rely on Pi's internal fallback renderer rather than exposing
		// renderCall. Keep every expanded call visible as an individual tree row.
		return new TreeRow(context.toolCallId, theme, true);
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
	const suffix = spec.summarizeResult
		? spec.summarizeResult(result, isError)
		: summarizeResult(spec.toolName, result, isError);
	updateRecord(context.toolCallId, { suffix: suffix ?? "", isError, running: false });

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
	private individual: boolean;

	constructor(toolCallId: string, theme: any, individual = false) {
		this.toolCallId = toolCallId;
		this.theme = theme;
		this.individual = individual;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const self = getRecord(this.toolCallId);
		if (!self) return [];
		if (this.individual) {
			const total = self.total ?? 1;
			const index = self.index ?? 0;
			return [
				this.memberLine(self, index === 0, index === total - 1, self.hasThinkingBefore ?? false, width),
			];
		}

		const members = (self.groupId ? groupMembers(self.groupId) : [self]).filter((m) => m.treeEnabled);
		if (members.length === 0) return [];
		// Only the first tree-enabled sibling draws the tree. Unsupported custom
		// tool blocks remain visible and cannot accidentally hide supported rows.
		if (members[0].toolCallId !== this.toolCallId) return [];
		const hasThinkingBefore = members.some((m) => m.hasThinkingBefore);
		return members.map((m, i) =>
			this.memberLine(m, i === 0, i === members.length - 1, hasThinkingBefore, width),
		);
	}

	private memberLine(
		m: ToolCallRecord,
		isFirst: boolean,
		isLast: boolean,
		hasThinkingBefore: boolean,
		width: number,
	): string {
		const theme = this.theme;
		const glyph = isLast ? "╰─" : isFirst && !hasThinkingBefore ? "╭─" : "├─";
		const status = m.running !== false
			? theme.fg("muted", "…")
			: m.isError
				? theme.fg("error", "✗")
				: theme.fg("dim", "✓");

		// Plain-text layout first so truncation is width-exact, then colorize.
		let name = m.toolName ?? "tool";
		let arg = m.callText ?? summarizeCall(m.toolName ?? "", m.args);
		const elapsed = m.startedAt === undefined ? undefined : (m.endedAt ?? Date.now()) - m.startedAt;
		let suffix = m.suffix ? ` → ${m.suffix}` : "";
		if (elapsed !== undefined) suffix += ` · ${formatDuration(elapsed)}`;

		// " " + subdued glyph + " " + status + " "
		const prefixWidth = 1 + glyph.length + 1 + 1 + 1;
		const bodyBudget = Math.max(0, width - prefixWidth);
		const bodyWidth = () => name.length + (arg ? 1 + arg.length : 0) + suffix.length;

		// Preserve tool name and result status; shrink the argument first.
		if (bodyWidth() > bodyBudget && arg) {
			const argBudget = bodyBudget - name.length - 1 - suffix.length;
			arg = argBudget > 4 ? truncate(arg, argBudget) : "";
		}
		if (bodyWidth() > bodyBudget && suffix) {
			const suffixBudget = bodyBudget - name.length;
			suffix = suffixBudget > 4 ? truncate(suffix, suffixBudget) : "";
		}
		if (bodyWidth() > bodyBudget) {
			name = bodyBudget > 2 ? truncate(name, bodyBudget) : "";
			arg = "";
			suffix = "";
		}

		const argText = arg ? ` ${theme.fg("accent", arg)}` : "";
		const suffixText = suffix ? theme.fg("dim", suffix) : "";
		return ` ${theme.fg("dim", glyph)} ${status} ${theme.fg("toolTitle", theme.bold(name))}${argText}${suffixText}`;
	}
}
