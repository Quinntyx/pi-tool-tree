/**
 * pi-tool-tree — Claude-style tool call tree rendering for pi.
 *
 * Every tool call renders as a single terminal line. Calls across all assistant
 * turns in one agent run form a tree block:
 *
 *   ● refactor session-state module        ← assistant text (untouched)
 *    ╭─ Thinking... 2.4s
 *    ├─ ✓ read src/session/state.ts · 0.3s
 *    ├─ ✓ grep /setLoading/ in src/ → 14 matches · 0.6s
 *    ╰─ ✗ bash npm test → exit 1 · 3.1s
 *
 * Built-in tools are wrapped automatically (execution inherited). Third-party
 * plugin tools opt in with the exported withToolTree() helper. ctrl+o expands
 * result output (and restores custom tools' original renderers).
 */
import hashlineEdit from "pi-hashline-edit";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createPowerShellTool,
	createReadTool,
	createWriteTool,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { clearRegistry, setGroup, updateRecord } from "./registry.ts";
import { treeRenderCall, treeRenderResult, type ToolTreeSpec } from "./render.ts";
import { formatDuration, summarizeCall, summarizeResult } from "./summarize.ts";

import { withToolTree } from "./with-tool-tree.ts";
export { withToolTree, type WithToolTreeOptions } from "./with-tool-tree.ts";

type ToolFactory = (cwd: string) => any;

const TOOL_FACTORIES: Record<string, ToolFactory> = {
	read: createReadTool,
	bash: createBashTool,
	edit: createEditTool,
	write: createWriteTool,
	grep: createGrepTool,
	find: createFindTool,
	ls: createLsTool,
	...(process.platform === "win32" ? { powershell: createPowerShellTool } : {}),
};

const builtinCache = new Map<string, Record<string, any>>();

function builtinsFor(cwd: string): Record<string, any> {
	let defs = builtinCache.get(cwd);
	if (!defs) {
		defs = {};
		for (const [name, factory] of Object.entries(TOOL_FACTORIES)) {
			try {
				defs[name] = factory(cwd);
			} catch {
				// e.g. powershell unavailable on this platform
			}
		}
		builtinCache.set(cwd, defs);
	}
	return defs;
}

export default function piToolTree(pi: ExtensionAPI) {
	wrapBuiltins(pi);
	registerHashlineTools(pi);
	wireRegistryEvents(pi);
	wireThinkingRenderer(pi);
}

/** Re-register built-in tools with tree rendering; execution stays built-in. */
function wrapBuiltins(pi: ExtensionAPI) {
	for (const name of Object.keys(TOOL_FACTORIES)) {
		const base = builtinsFor(process.cwd())[name];
		if (!base) continue;

		const spec: ToolTreeSpec = {
			toolName: name,
			originalRenderCall: base.renderCall,
			originalRenderResult: base.renderResult,
		};

		pi.registerTool({
			name,
			label: base.label ?? name,
			description: base.description,
			parameters: base.parameters,
			renderShell: "self",
			execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
				const tool = builtinsFor(ctx.cwd)[name];
				return tool.execute(toolCallId, params, signal, onUpdate);
			},
			renderCall(args: any, theme: any, context: any) {
				return treeRenderCall(spec, args, theme, context);
			},
			renderResult(result: any, options: any, theme: any, context: any) {
				return treeRenderResult(spec, result, options, theme, context);
			},
		} as any);
	}
}

/** Register hashline's read/edit/grep implementations through our renderer. */
function registerHashlineTools(pi: ExtensionAPI) {
	const treePi = new Proxy(pi as any, {
		get(target, property, receiver) {
			if (property === "registerTool") {
				return (tool: Record<string, any>) => pi.registerTool(withToolTree(tool) as any);
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	hashlineEdit(treePi);
}

/** Feed the shared registry from pi's lifecycle events. */
function wireRegistryEvents(pi: ExtensionAPI) {
	let activeRunId: string | undefined;
	let runSequence = 0;

	const recordGroups = (event: any) => {
		const message = event?.message;
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return;
		const calls = message.content.filter((c: any) => c?.type === "toolCall" && c.id);
		if (calls.length === 0) return;
		const hasThinking = message.content.some(
			(c: any) => c?.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim(),
		);
		activeRunId ??= `run:${Date.now()}:${++runSequence}`;
		setGroup(
			calls.map((c: any) => ({ id: c.id, name: c.name, args: c.arguments })),
			hasThinking,
			activeRunId,
		);
	};

	pi.on("agent_start" as any, async () => {
		activeRunId ??= `run:${Date.now()}:${++runSequence}`;
	});
	pi.on("agent_settled" as any, async () => {
		activeRunId = undefined;
	});
	pi.on("message_update" as any, recordGroups as any);
	pi.on("message_end" as any, recordGroups as any);

	pi.on("tool_execution_start" as any, async (event: any) => {
		updateRecord(event.toolCallId, {
			toolName: event.toolName,
			running: true,
			startedAt: Date.now(),
		});
	});

	pi.on("tool_execution_end" as any, async (event: any) => {
		updateRecord(event.toolCallId, {
			running: false,
			isError: event.isError,
			endedAt: Date.now(),
		});
	});

	pi.on("session_start" as any, async (_event: any, ctx: any) => {
		activeRunId = undefined;
		clearRegistry();
		rebuildFromSession(ctx.sessionManager.getEntries());
	});
}

/**
 * Rebuild the registry from persisted session entries so restored sessions
 * render the same collapsed trees instead of falling back to single rows.
 */
function rebuildFromSession(entries: any[]) {
	let restoredRunId: string | undefined;
	for (const entry of entries) {
		const message = entry?.message;
		if (!message) continue;

		if (message.role === "user") {
			restoredRunId = `restored:${entry.id}`;
			continue;
		}
		if (message.role === "assistant" && Array.isArray(message.content)) {
			const calls = message.content.filter((c: any) => c?.type === "toolCall" && c.id);
			if (calls.length > 0) {
				const hasThinking = message.content.some(
					(c: any) =>
						c?.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim(),
				);
				const groupId = restoredRunId ?? `restored:${calls[0].id}`;
				setGroup(
					calls.map((c: any) => ({ id: c.id, name: c.name, args: c.arguments })),
					hasThinking,
					groupId,
				);
				for (const c of calls) {
					updateRecord(c.id, { callText: summarizeCall(c.name, c.arguments) });
				}
			}
		} else if (message.role === "toolResult" && message.toolCallId) {
			updateRecord(message.toolCallId, {
				toolName: message.toolName,
				running: false,
				isError: message.isError,
				suffix: summarizeResult(message.toolName, message, message.isError) ?? "",
			});
		}
	}
}

/** Collapse visible reasoning into one timed tree row without changing context. */
function wireThinkingRenderer(pi: ExtensionAPI) {
	let startedAt: number | undefined;
	let endedAt: number | undefined;
	const finalizedDurations = new Map<string, number>();

	pi.on("session_start" as any, async () => {
		startedAt = undefined;
		endedAt = undefined;
		finalizedDurations.clear();
	});

	pi.on("message_start" as any, async (event: any) => {
		if (event?.message?.role !== "assistant") return;
		startedAt = undefined;
		endedAt = undefined;
	});

	pi.on("message_update" as any, async (event: any) => {
		const streamEvent = event?.assistantMessageEvent;
		if (streamEvent?.type === "thinking_start") {
			startedAt ??= Date.now();
			endedAt = undefined;
		} else if (streamEvent?.type === "thinking_end" && startedAt !== undefined) {
			endedAt = Date.now();
		}
	});

	pi.on("message_end" as any, async (event: any) => {
		const message = event?.message;
		if (message?.role !== "assistant") return;
		if (startedAt !== undefined) {
			const elapsed = (endedAt ?? Date.now()) - startedAt;
			for (const run of thinkingRuns(message.content)) finalizedDurations.set(run, elapsed);
		}
		startedAt = undefined;
		endedAt = undefined;
	});

	pi.registerMarkdownTransformer((markdown: string, options: any) => {
		if (options.messageType !== "assistant-thinking") return markdown;

		if (options.isStreaming && startedAt === undefined) startedAt = Date.now();
		const elapsed =
			finalizedDurations.get(markdown) ??
			(startedAt === undefined ? undefined : (endedAt ?? Date.now()) - startedAt);
		return `╭─ Thinking...${elapsed === undefined ? "" : ` ${formatDuration(elapsed)}`}`;
	});
}

/** Match AssistantMessageComponent's grouping of consecutive thinking blocks. */
function thinkingRuns(content: any): string[] {
	if (!Array.isArray(content)) return [];
	const runs: string[] = [];
	for (let i = 0; i < content.length; i++) {
		if (content[i]?.type !== "thinking") continue;
		const blocks: string[] = [];
		for (; i < content.length && content[i]?.type === "thinking"; i++) {
			const text = typeof content[i].thinking === "string" ? content[i].thinking.trim() : "";
			if (text) blocks.push(text);
		}
		i--;
		if (blocks.length > 0) runs.push(blocks.join("\n\n"));
	}
	return runs;
}
