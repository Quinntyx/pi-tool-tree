import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	findThinkingByText,
	getRun,
	getThinking,
	getTool,
	updateActiveThinking,
	updateTool,
	type RunItem,
	type ThinkingRecord,
	type ToolCallRecord,
} from "./registry.ts";
import { formatDuration, summarizeCall, summarizeResult } from "./summarize.ts";

export interface ToolTreeSpec {
	toolName: string;
	summarizeCall?: (args: any) => string | undefined;
	summarizeResult?: (result: any, isError: boolean) => string | undefined;
	originalRenderCall?: ((args: any, theme: any, context: any) => any) | undefined;
	originalRenderResult?: ((result: any, options: any, theme: any, context: any) => any) | undefined;
}

class EmptyComponent {
	invalidate(): void {}
	render(): string[] {
		return [];
	}
}

/** Hide the ordinary tool row when a run-level entry owns its rendering. */
export function treeRenderCall(spec: ToolTreeSpec, args: any, theme: any, context: any) {
	const custom = spec.summarizeCall?.(args);
	const callText = custom !== undefined ? custom : summarizeCall(spec.toolName, args);
	const record = updateTool(context.toolCallId, {
		toolName: spec.toolName,
		args,
		callText,
	});
	const run = record.runId ? getRun(record.runId) : undefined;
	if (run?.hasEntry) return new EmptyComponent();

	if (context.expanded && spec.originalRenderCall) {
		return spec.originalRenderCall(args, theme, context);
	}
	return new LegacyToolRow(context.toolCallId, theme);
}

/** Capture result/detail rendering for the run-level tree and hide the source row. */
export function treeRenderResult(
	spec: ToolTreeSpec,
	result: any,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: any,
	context: any,
) {
	const isError = result?.isError ?? context.isError ?? false;
	const suffix = spec.summarizeResult
		? spec.summarizeResult(result, isError)
		: summarizeResult(spec.toolName, result, isError);
	let detailComponent: any;
	if (spec.originalRenderResult) {
		try {
			detailComponent = spec.originalRenderResult(result, options, theme, context);
		} catch {
			detailComponent = undefined;
		}
	}
	const record = updateTool(context.toolCallId, {
		suffix: suffix ?? "",
		isError,
		partialResult: options.isPartial ? result : null,
		result: options.isPartial ? undefined : result,
		detailComponent,
	});
	const run = record.runId ? getRun(record.runId) : undefined;
	if (run?.hasEntry) return new EmptyComponent();

	if (options.expanded) {
		if (detailComponent) return detailComponent;
		return rawResultComponent(result, theme);
	}
	return new Text("", 0, 0);
}

/** Display-only thinking transform: the run component renders managed thinking. */
export function hideManagedThinking(markdown: string, isStreaming: boolean): string {
	const record = isStreaming ? updateActiveThinking(markdown) : findThinkingByText(markdown);
	return record && getRun(record.runId)?.hasEntry ? "" : markdown;
}

export class RunTreeComponent {
	private runId: string;
	private expanded: boolean;
	private theme: any;

	constructor(runId: string, expanded: boolean, theme: any) {
		this.runId = runId;
		this.expanded = expanded;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const run = getRun(this.runId);
		if (!run) return [];
		const items = run.items.filter((item) => this.resolveItem(item) !== undefined);
		const lines: string[] = [];
		items.forEach((item, index) => {
			const glyph = items.length === 1 ? "╰─" : index === 0 ? "╭─" : index === items.length - 1 ? "╰─" : "├─";
			if (item.kind === "thinking") {
				const thinking = getThinking(item.id);
				if (thinking) lines.push(...this.renderThinking(thinking, glyph, width));
			} else {
				const tool = getTool(item.id);
				if (tool) lines.push(...this.renderTool(tool, glyph, width));
			}
		});
		// Hard safety boundary: a custom component must never exceed terminal width.
		return lines.map((line) => safeLine(line, width));
	}

	private resolveItem(item: RunItem): ThinkingRecord | ToolCallRecord | undefined {
		return item.kind === "thinking" ? getThinking(item.id) : getTool(item.id);
	}

	private renderThinking(record: ThinkingRecord, glyph: string, width: number): string[] {
		const elapsed = (record.endedAt ?? Date.now()) - record.startedAt;
		const label = record.endedAt === undefined ? "Thinking..." : "Thought for";
		const header = `${this.theme.fg("dim", glyph)} ${this.theme.italic(
			this.theme.fg("thinkingText", `${label} ${formatDuration(elapsed)}`),
		)}`;
		const lines = [header];
		if ((!record.collapsed || this.expanded) && record.text.trim()) {
			lines.push(...this.nestedText(record.text, "thinkingText", width));
		}
		return lines;
	}

	private renderTool(record: ToolCallRecord, glyph: string, width: number): string[] {
		const running = record.running !== false;
		const status = running
			? this.theme.fg("muted", "…")
			: record.isError
				? this.theme.fg("error", "✗")
				: this.theme.fg("dim", "✓");
		const elapsed = record.startedAt === undefined ? undefined : (record.endedAt ?? Date.now()) - record.startedAt;
		let suffix = record.suffix ? ` → ${record.suffix}` : "";
		if (elapsed !== undefined) suffix += ` · ${formatDuration(elapsed)}`;
		const name = record.toolName ?? "tool";
		const arg = record.callText ?? summarizeCall(name, record.args);
		const header = `${this.theme.fg("dim", glyph)} ${status} ${this.theme.fg(
			"toolTitle",
			this.theme.bold(name),
		)}${arg ? ` ${this.theme.fg("accent", arg)}` : ""}${suffix ? this.theme.fg("dim", suffix) : ""}`;
		const lines = [header];
		if (record.showDetails || this.expanded) lines.push(...this.renderToolDetails(record, width));
		return lines;
	}

	private renderToolDetails(record: ToolCallRecord, width: number): string[] {
		const prefix = this.theme.fg("dim", "│  ");
		const prefixWidth = visibleWidth(prefix);
		const contentWidth = Math.max(1, width - prefixWidth);
		let detailLines: string[] = [];

		if (record.detailComponent?.render) {
			try {
				detailLines = record.detailComponent.render(contentWidth);
			} catch {
				detailLines = [];
			}
		}
		if (detailLines.length === 0) {
			const result = record.partialResult ?? record.result;
			const text = textResult(result);
			if (text) {
				for (const sourceLine of text.split("\n")) {
					const colored = this.theme.fg("toolOutput", sourceLine);
					detailLines.push(...wrapTextWithAnsi(colored, contentWidth));
				}
			}
		}

		const limit = this.expanded ? 200 : 12;
		const hidden = Math.max(0, detailLines.length - limit);
		if (hidden > 0) detailLines = detailLines.slice(-limit);
		const output = detailLines.map((line) => `${prefix}${truncateToWidth(line, contentWidth)}`);
		if (hidden > 0) {
			output.unshift(`${prefix}${this.theme.fg("dim", `… ${hidden} earlier lines`)}`);
		}
		return output;
	}

	private nestedText(text: string, color: string, width: number): string[] {
		const prefix = this.theme.fg("dim", "│  ");
		const contentWidth = Math.max(1, width - visibleWidth(prefix));
		const lines: string[] = [];
		for (const sourceLine of text.split("\n")) {
			const styled = this.theme.italic(this.theme.fg(color, sourceLine));
			for (const line of wrapTextWithAnsi(styled, contentWidth)) lines.push(`${prefix}${line}`);
		}
		return lines;
	}
}

class LegacyToolRow {
	private toolCallId: string;
	private theme: any;
	constructor(toolCallId: string, theme: any) {
		this.toolCallId = toolCallId;
		this.theme = theme;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const record = getTool(this.toolCallId);
		if (!record) return [];
		const status = record.running !== false ? "…" : record.isError ? "✗" : "✓";
		const text = ` ${this.theme.fg("dim", "╰─")} ${this.theme.fg(
			record.isError ? "error" : "dim",
			status,
		)} ${this.theme.fg("toolTitle", this.theme.bold(record.toolName ?? "tool"))} ${this.theme.fg(
			"accent",
			record.callText ?? "",
		)}`;
		return [safeLine(text, width)];
	}
}

function rawResultComponent(result: any, theme: any): Text {
	const text = textResult(result);
	return new Text(text ? theme.fg("toolOutput", text) : "", 0, 0);
}

function textResult(result: any): string {
	return Array.isArray(result?.content)
		? result.content
				.filter((item: any) => item?.type === "text" && typeof item.text === "string")
				.map((item: any) => item.text)
				.join("\n")
		: "";
}

function safeLine(line: string, width: number): string {
	const safeWidth = Math.max(0, width);
	return visibleWidth(line) <= safeWidth ? line : truncateToWidth(line, safeWidth);
}
