/**
 * pi-tool-tree — one live, compact transcript tree per agent run.
 *
 *   ╭─ Thinking... 2.4s
 *   │  live reasoning tokens…
 *   ├─ ✓ read src/session/state.ts · 0.3s
 *   ╰─ … bash npm test · 1.8s
 *      live command output…
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
import {
	beginRun,
	beginThinking,
	clearRegistry,
	endActiveThinking,
	finishTool,
	getCurrentRun,
	settleCurrentRun,
	startTool,
	updateActiveThinking,
	updateTool,
} from "./registry.ts";
import {
	hideManagedThinking,
	RunTreeComponent,
	treeRenderCall,
	treeRenderResult,
	type ToolTreeSpec,
} from "./render.ts";
import { summarizeCall, summarizeResult } from "./summarize.ts";
import { withToolTree } from "./with-tool-tree.ts";

export { withToolTree, type WithToolTreeOptions } from "./with-tool-tree.ts";

const RUN_ENTRY_TYPE = "pi-tool-tree-run";
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
	let definitions = builtinCache.get(cwd);
	if (!definitions) {
		definitions = {};
		for (const [name, factory] of Object.entries(TOOL_FACTORIES)) {
			try {
				definitions[name] = factory(cwd);
			} catch {
				// e.g. powershell unavailable on this platform
			}
		}
		builtinCache.set(cwd, definitions);
	}
	return definitions;
}

export default function piToolTree(pi: ExtensionAPI) {
	wrapBuiltins(pi);
	registerHashlineTools(pi);
	registerRunRenderer(pi);
	wireLifecycle(pi);
}

/** Re-register stock tools with execution unchanged and source rows hidden. */
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
				return builtinsFor(ctx.cwd)[name].execute(toolCallId, params, signal, onUpdate);
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

/** Preserve hashline read/edit/grep behavior while wrapping its render slots. */
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

function registerRunRenderer(pi: ExtensionAPI) {
	pi.registerEntryRenderer<{ runId: string }>(RUN_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const runId = entry.data?.runId;
		return runId ? new RunTreeComponent(runId, expanded, theme) : undefined;
	});
}

function wireLifecycle(pi: ExtensionAPI) {
	let runSequence = 0;

	pi.on("session_start", async (_event, ctx) => {
		clearRegistry();
		rebuildFromSession(ctx.sessionManager.getEntries());
	});

	pi.on("agent_start", async (_event, ctx) => {
		// Auto-retries can emit another agent_start before agent_settled.
		if (getCurrentRun()) return;
		const runId = `run:${Date.now()}:${++runSequence}`;
		const hasEntry = ctx.mode === "tui";
		beginRun(runId, hasEntry);
		if (hasEntry) pi.appendEntry(RUN_ENTRY_TYPE, { runId });
	});

	pi.on("agent_settled", async () => {
		settleCurrentRun();
	});

	pi.on("message_update", async (event: any) => {
		const message = event.message;
		if (message?.role === "assistant" && Array.isArray(message.content)) {
			for (const content of message.content) {
				if (content?.type === "toolCall" && content.id) {
					updateTool(content.id, {
						toolName: content.name,
						args: content.arguments,
						callText: summarizeCall(content.name, content.arguments),
					});
				}
			}
		}

		const stream = event.assistantMessageEvent;
		if (stream?.type === "thinking_start") {
			const text = thinkingAt(message, stream.contentIndex);
			beginThinking(text);
		} else if (stream?.type === "thinking_delta") {
			updateActiveThinking(thinkingAt(message, stream.contentIndex));
		} else if (stream?.type === "thinking_end") {
			endActiveThinking(stream.content);
		}
	});

	pi.on("message_end", async (event: any) => {
		const message = event.message;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
		for (const content of message.content) {
			if (content?.type === "toolCall" && content.id) {
				updateTool(content.id, {
					toolName: content.name,
					args: content.arguments,
					callText: summarizeCall(content.name, content.arguments),
				});
			}
		}
	});

	pi.on("tool_execution_start", async (event: any) => {
		startTool(event.toolCallId, {
			toolName: event.toolName,
			args: event.args,
			callText: summarizeCall(event.toolName, event.args),
		});
	});

	pi.on("tool_execution_update", async (event: any) => {
		updateTool(event.toolCallId, { partialResult: event.partialResult, showDetails: true });
	});

	pi.on("tool_execution_end", async (event: any) => {
		finishTool(event.toolCallId, {
			toolName: event.toolName,
			result: event.result,
			partialResult: null,
			isError: event.isError,
			suffix: summarizeResult(event.toolName, event.result, event.isError) ?? "",
		});
	});

	pi.registerMarkdownTransformer((markdown, options) => {
		if (options.messageType !== "assistant-thinking") return markdown;
		return hideManagedThinking(markdown, options.isStreaming);
	});
}

function thinkingAt(message: any, contentIndex: number): string {
	const content = message?.content?.[contentIndex];
	return content?.type === "thinking" && typeof content.thinking === "string" ? content.thinking : "";
}

/** Rehydrate trees for sessions that already contain pi-tool-tree run entries. */
function rebuildFromSession(entries: any[]) {
	for (const entry of entries) {
		if (entry?.type === "custom" && entry.customType === RUN_ENTRY_TYPE && entry.data?.runId) {
			beginRun(entry.data.runId, true);
			continue;
		}
		const message = entry?.message;
		const run = getCurrentRun();
		if (!message || !run?.hasEntry) continue;

		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const content of message.content) {
				if (content?.type === "thinking" && typeof content.thinking === "string" && content.thinking.trim()) {
					const thinking = beginThinking(content.thinking.trim());
					endActiveThinking(content.thinking.trim());
					if (thinking) thinking.collapsed = true;
				} else if (content?.type === "toolCall" && content.id) {
					updateTool(content.id, {
						toolName: content.name,
						args: content.arguments,
						callText: summarizeCall(content.name, content.arguments),
						running: false,
					});
				}
			}
		} else if (message.role === "toolResult" && message.toolCallId) {
			updateTool(message.toolCallId, {
				toolName: message.toolName,
				result: message,
				running: false,
				isError: message.isError,
				suffix: summarizeResult(message.toolName, message, message.isError) ?? "",
				showDetails: false,
			});
		}
	}
	settleCurrentRun();
}
