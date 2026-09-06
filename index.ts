/**
 * pi-tool-tree — Claude-style tool call tree rendering for pi.
 *
 * Every tool call renders as a single terminal line. Sibling tool calls
 * (from one assistant message) form a tree block:
 *
 *   ● refactor session-state module        ← assistant text (untouched)
 *    ⎿✓ read src/session/state.ts
 *    ├─✓ grep /setLoading/ in src/ → 14 matches
 *    └─✗ bash npm test → exit 1
 *
 * Built-in tools are wrapped automatically (execution inherited). Third-party
 * plugin tools opt in with the exported withToolTree() helper. ctrl+o expands
 * rows back to pi's full default rendering.
 */
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
import { summarizeCall, summarizeResult } from "./summarize.ts";

export { withToolTree, type WithToolTreeOptions } from "./with-tool-tree.ts";

type ToolFactory = (cwd: string) => any;

const TOOL_FACTORIES: Record<string, ToolFactory> = {
	read: createReadTool,
	bash: createBashTool,
	powershell: createPowerShellTool,
	edit: createEditTool,
	write: createWriteTool,
	grep: createGrepTool,
	find: createFindTool,
	ls: createLsTool,
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
	wireRegistryEvents(pi);
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

/** Feed the shared registry from pi's lifecycle events. */
function wireRegistryEvents(pi: ExtensionAPI) {
	const recordGroups = (event: any) => {
		const message = event?.message;
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return;
		const calls = message.content.filter((c: any) => c?.type === "toolCall" && c.id);
		if (calls.length === 0) return;
		setGroup(calls.map((c: any) => ({ id: c.id, name: c.name, args: c.arguments })));
	};

	pi.on("message_update" as any, recordGroups as any);
	pi.on("message_end" as any, recordGroups as any);

	pi.on("tool_execution_start" as any, async (event: any) => {
		updateRecord(event.toolCallId, { toolName: event.toolName, running: true });
	});

	pi.on("tool_execution_end" as any, async (event: any) => {
		updateRecord(event.toolCallId, { running: false, isError: event.isError });
	});

	pi.on("session_start" as any, async (_event: any, ctx: any) => {
		clearRegistry();
		rebuildFromSession(ctx.sessionManager.getEntries());
	});
}

/**
 * Rebuild the registry from persisted session entries so restored sessions
 * render the same collapsed trees instead of falling back to single rows.
 */
function rebuildFromSession(entries: any[]) {
	for (const entry of entries) {
		const message = entry?.message;
		if (!message) continue;

		if (message.role === "assistant" && Array.isArray(message.content)) {
			const calls = message.content.filter((c: any) => c?.type === "toolCall" && c.id);
			if (calls.length > 0) {
				setGroup(calls.map((c: any) => ({ id: c.id, name: c.name, args: c.arguments })));
				for (const c of calls) {
					updateRecord(c.id, { callText: summarizeCall(c.name, c.arguments) });
				}
			}
		} else if (message.role === "toolResult" && message.toolCallId) {
			updateRecord(message.toolCallId, {
				toolName: message.toolName,
				running: false,
				isError: message.isError,
				suffix: summarizeResult(message.toolName, message, message.isError),
			});
		}
	}
}
