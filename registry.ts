/** Shared live state for run-level tool trees. */

export interface ToolCallRecord {
	toolCallId: string;
	runId?: string;
	toolName?: string;
	args?: unknown;
	callText?: string;
	suffix?: string;
	running?: boolean;
	isError?: boolean;
	startedAt?: number;
	endedAt?: number;
	partialResult?: any;
	result?: any;
	detailComponent?: any;
	showDetails?: boolean;
}

export interface ThinkingRecord {
	thinkingId: string;
	runId: string;
	text: string;
	startedAt: number;
	endedAt?: number;
	collapsed: boolean;
}

export type RunItem =
	| { kind: "thinking"; id: string }
	| { kind: "tool"; id: string };

export interface RunRecord {
	runId: string;
	hasEntry: boolean;
	active: boolean;
	items: RunItem[];
	activeThinkingId?: string;
	activeToolId?: string;
}

interface Store {
	runs: Map<string, RunRecord>;
	calls: Map<string, ToolCallRecord>;
	thinking: Map<string, ThinkingRecord>;
	currentRunId?: string;
	thinkingSequence: number;
}

const KEY = Symbol.for("pi-tool-tree.registry.v3");

function store(): Store {
	const global = globalThis as Record<symbol, unknown>;
	if (!global[KEY]) {
		global[KEY] = {
			runs: new Map<string, RunRecord>(),
			calls: new Map<string, ToolCallRecord>(),
			thinking: new Map<string, ThinkingRecord>(),
			thinkingSequence: 0,
		};
	}
	return global[KEY] as Store;
}

export function clearRegistry(): void {
	const state = store();
	state.runs.clear();
	state.calls.clear();
	state.thinking.clear();
	state.currentRunId = undefined;
	state.thinkingSequence = 0;
}

export function beginRun(runId: string, hasEntry: boolean): RunRecord {
	const state = store();
	const previous = state.currentRunId ? state.runs.get(state.currentRunId) : undefined;
	if (previous && previous.runId !== runId) collapseRun(previous.runId);
	const run = state.runs.get(runId) ?? {
		runId,
		hasEntry,
		active: true,
		items: [],
	};
	run.hasEntry ||= hasEntry;
	run.active = true;
	state.runs.set(runId, run);
	state.currentRunId = runId;
	return run;
}

export function getRun(runId: string): RunRecord | undefined {
	return store().runs.get(runId);
}

export function getCurrentRun(): RunRecord | undefined {
	const state = store();
	return state.currentRunId ? state.runs.get(state.currentRunId) : undefined;
}

export function settleCurrentRun(): void {
	const state = store();
	if (!state.currentRunId) return;
	collapseRun(state.currentRunId);
	const run = state.runs.get(state.currentRunId);
	if (run) run.active = false;
	state.currentRunId = undefined;
}

export function collapseRun(runId: string): void {
	const state = store();
	const run = state.runs.get(runId);
	if (!run) return;
	for (const item of run.items) {
		if (item.kind === "thinking") {
			const thinking = state.thinking.get(item.id);
			if (thinking) {
				thinking.collapsed = true;
				thinking.endedAt ??= Date.now();
			}
		} else {
			const call = state.calls.get(item.id);
			if (call) {
				call.showDetails = false;
				if (call.running !== false) {
					call.running = false;
					call.endedAt ??= Date.now();
				}
			}
		}
	}
	run.activeThinkingId = undefined;
	run.activeToolId = undefined;
}

function addItem(run: RunRecord, item: RunItem): void {
	if (!run.items.some((existing) => existing.kind === item.kind && existing.id === item.id)) {
		run.items.push(item);
	}
}

export function getTool(toolCallId: string): ToolCallRecord | undefined {
	return store().calls.get(toolCallId);
}

export function updateTool(toolCallId: string, patch: Partial<ToolCallRecord>): ToolCallRecord {
	const state = store();
	const existing = state.calls.get(toolCallId);
	const run = existing?.runId
		? state.runs.get(existing.runId)
		: state.currentRunId
			? state.runs.get(state.currentRunId)
			: undefined;
	const clean: Partial<ToolCallRecord> = {};
	for (const [key, value] of Object.entries(patch)) {
		if (value !== undefined) (clean as Record<string, unknown>)[key] = value;
	}
	const merged: ToolCallRecord = {
		toolCallId,
		...existing,
		...(run ? { runId: run.runId } : {}),
		...clean,
	};
	state.calls.set(toolCallId, merged);
	if (run) addItem(run, { kind: "tool", id: toolCallId });
	return merged;
}

export function startTool(toolCallId: string, patch: Partial<ToolCallRecord>): ToolCallRecord {
	const state = store();
	const run = getCurrentRun();
	if (run) {
		for (const item of run.items) {
			if (item.kind === "tool") {
				const previous = state.calls.get(item.id);
				if (previous) previous.showDetails = false;
			}
		}
		run.activeToolId = toolCallId;
	}
	return updateTool(toolCallId, {
		...patch,
		running: true,
		startedAt: Date.now(),
		showDetails: true,
	});
}

export function finishTool(toolCallId: string, patch: Partial<ToolCallRecord>): ToolCallRecord {
	return updateTool(toolCallId, {
		...patch,
		running: false,
		endedAt: Date.now(),
		showDetails: true,
	});
}

export function beginThinking(text = ""): ThinkingRecord | undefined {
	const state = store();
	const run = getCurrentRun();
	if (!run?.hasEntry) return undefined;
	if (run.activeThinkingId) {
		const active = state.thinking.get(run.activeThinkingId);
		if (active) {
			if (text) active.text = text;
			return active;
		}
	}

	// A new thinking block collapses the previous thinking and active tool detail.
	for (const item of run.items) {
		if (item.kind === "thinking") {
			const previous = state.thinking.get(item.id);
			if (previous) previous.collapsed = true;
		} else {
			const call = state.calls.get(item.id);
			if (call) call.showDetails = false;
		}
	}

	const thinkingId = `${run.runId}:thinking:${++state.thinkingSequence}`;
	const record: ThinkingRecord = {
		thinkingId,
		runId: run.runId,
		text,
		startedAt: Date.now(),
		collapsed: false,
	};
	state.thinking.set(thinkingId, record);
	addItem(run, { kind: "thinking", id: thinkingId });
	run.activeThinkingId = thinkingId;
	run.activeToolId = undefined;
	return record;
}

export function updateActiveThinking(text: string): ThinkingRecord | undefined {
	const run = getCurrentRun();
	const record = run?.activeThinkingId ? store().thinking.get(run.activeThinkingId) : beginThinking(text);
	if (record) record.text = text;
	return record;
}

export function endActiveThinking(text?: string): ThinkingRecord | undefined {
	const run = getCurrentRun();
	if (!run?.activeThinkingId) return undefined;
	const record = store().thinking.get(run.activeThinkingId);
	if (record) {
		if (text !== undefined) record.text = text;
		record.endedAt = Date.now();
	}
	run.activeThinkingId = undefined;
	return record;
}

export function getThinking(thinkingId: string): ThinkingRecord | undefined {
	return store().thinking.get(thinkingId);
}

export function findThinkingByText(text: string): ThinkingRecord | undefined {
	const state = store();
	const records = Array.from(state.thinking.values());
	for (let i = records.length - 1; i >= 0; i--) {
		if (records[i].text === text) return records[i];
	}
	return undefined;
}
