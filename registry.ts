/**
 * Shared tool-call registry for pi-tool-tree.
 *
 * State lives on `globalThis` under a well-known symbol so every module
 * instance shares a single registry — including `withToolTree()` helpers
 * imported by other plugins through their own module resolution.
 */

export interface ToolCallRecord {
	/** Unique tool execution id. */
	toolCallId: string;
	/** Tool name, when known. */
	toolName?: string;
	/** Arguments snapshot (used to summarize the call line). */
	args?: unknown;
	/** Summarized call text (plain, single line). Written by the row's renderCall. */
	callText?: string;
	/** Result suffix (plain text, e.g. "14 matches"). Written by the row's renderResult. */
	suffix?: string;
	/** Group id: shared by all tool calls of one assistant message. */
	groupId?: string;
	/** Position within the sibling group (0-based). */
	index?: number;
	/** Sibling group size. */
	total?: number;
	/** Whether this call opted into tree rendering. */
	treeEnabled?: boolean;
	/** Whether execution is currently running. */
	running?: boolean;
	/** Whether the result was an error. */
	isError?: boolean;
}

const KEY = Symbol.for("pi-tool-tree.registry.v1");

interface Store {
	calls: Map<string, ToolCallRecord>;
}

function store(): Store {
	const g = globalThis as Record<symbol, unknown>;
	if (!g[KEY]) {
		g[KEY] = { calls: new Map<string, ToolCallRecord>() };
	}
	return g[KEY] as Store;
}

export function getRecord(toolCallId: string): ToolCallRecord | undefined {
	return store().calls.get(toolCallId);
}

export function updateRecord(toolCallId: string, patch: Partial<ToolCallRecord>): ToolCallRecord {
	const calls = store().calls;
	const existing = calls.get(toolCallId);
	// `undefined` patch values mean "leave unchanged"
	const clean: Partial<ToolCallRecord> = {};
	for (const [k, v] of Object.entries(patch)) {
		if (v !== undefined) (clean as Record<string, unknown>)[k] = v;
	}
	const merged: ToolCallRecord = { toolCallId, ...existing, ...clean };
	calls.set(toolCallId, merged);
	return merged;
}

/**
 * Record sibling groups from one assistant message's tool calls.
 * All calls in a message share a groupId; index/total position them in
 * assistant source order (which is how pi emits tool_execution_start).
 */
export function setGroup(calls: Array<{ id: string; name?: string; args?: unknown }>): void {
	if (calls.length === 0) return;
	const groupId = calls[0].id;
	calls.forEach((c, i) => {
		updateRecord(c.id, { groupId, index: i, total: calls.length, toolName: c.name, args: c.args });
	});
}

/** All records belonging to a group, ordered by index. */
export function groupMembers(groupId: string): ToolCallRecord[] {
	const out: ToolCallRecord[] = [];
	for (const rec of store().calls.values()) {
		if (rec.groupId === groupId) out.push(rec);
	}
	out.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
	return out;
}

export function clearRegistry(): void {
	store().calls.clear();
}
