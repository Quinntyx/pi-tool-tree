/**
 * Render a sample transcript with the real extension renderers so the activity
 * grouping can be eyeballed without launching pi.
 *
 *   bun scripts/preview-trace.ts [width]
 */
import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { initTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import extension from "../extensions/index.ts";

const WIDTH = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 100);
// `--plain` drops every activity label, i.e. what you see after `/cc-tools activity off`.
const PLAIN = process.argv.includes("--plain");
// `--color` keeps the ANSI SGR colors (default strips them for copy/paste).
const COLOR = process.argv.includes("--color");

initTheme("dark", false);
const handlers = new Map<string, any[]>();
const commands = new Map<string, any>();
const tools = new Map<string, any>();
const pi = {
	registerTool(tool: any) { tools.set(tool.name, tool); },
	registerCommand(name: string, command: any) { commands.set(name, command); },
	registerShortcut() {},
	on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
};
const realHome = process.env.HOME;
process.env.HOME = `${realHome}/.pi-preview-${Date.now()}`;
extension(pi as any);
process.env.HOME = realHome;

// Deterministic clock so the group headers show plausible durations.
let clock = Date.parse("2026-01-01T00:00:00Z");
Date.now = () => clock;
const advance = (ms: number) => { clock += ms; };

const ui = { requestRender() {} };
const root = new Container();
let nextId = 0;

/** pi-ptc-next's code_execution tool: rendered by that extension, not ours. */
tools.set("web_search", {
    	name: "web_search",
    	label: "web_search",
    	description: "Search the web",
    	parameters: {},
    	renderCall(args: any) { return new Text(`[web] ${String(args?.query ?? "").slice(0, 50)}`, 0, 0); },
    	renderResult(_r: any, { isPartial }: any) { return new Text(isPartial ? "searching…" : "\u2713 3 sources", 0, 0); },
    } as any);
    tools.set("code_execution", {
	name: "code_execution",
	label: "Code Execution",
	description: "Run Python with programmatic tool calls",
	parameters: {},
	renderCall(args: any) {
		return new Text(`[python] ${String(args?.code ?? "").trim().split("\n")[0].slice(0, 60)}`, 0, 0);
	},
	renderResult(_result: any, { isPartial, expanded }: any) {
		const lines = expanded ? ["✓ 2 tool calls · 0.42s", "  read(3 files) · grep(1 pattern)"] : ["✓ 2 tool calls · 0.42s"];
		return new Text(isPartial ? "running…" : lines.join("\n"), 0, 0);
	},
} as any);

function startTool(name: string, args: any, activity?: string) {
	const id = `call_${++nextId}`;
	const payload = activity && !PLAIN ? { ...args, activity } : args;
	advance(120);
	handlers.get("tool_execution_start")?.forEach((h) => h({ toolCallId: id, toolName: name, args: payload }, ui));
	const component = new ToolExecutionComponent(name, id, payload, {}, tools.get(name), ui, process.cwd());
	component.markExecutionStarted();
	return { id, component };
}

function finishTool(tool: { id: string; component: any }, result: string, ms: number, isError = false) {
	advance(ms);
	handlers.get("tool_execution_end")?.forEach((h) => h({ toolCallId: tool.id, toolName: "", args: {} }, ui));
	tool.component.updateResult({ content: [{ type: "text", text: result }], isError } as any, false);
	root.addChild(tool.component);
}

function tool(name: string, args: any, activity: string | undefined, result: string, ms: number, isError = false) {
	const started = startTool(name, args, activity);
	finishTool(started, result, ms, isError);
}

function thinking(text: string, ms: number) {
	const message = { role: "assistant", content: [{ type: "thinking", thinking: text }], stopReason: "toolUse", _piClaudeStyleThinkingActive: false, _piClaudeStyleThinkingDurationMs: ms } as any;
	const component = new AssistantMessageComponent(message, false);
	component.updateContent(message, false);
	root.addChild(component);
}

function prose(text: string) {
	const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } as any;
	const component = new AssistantMessageComponent(message, false);
	component.updateContent(message, false);
	root.addChild(component);
}

// ---------------------------------------------------------------------------
// A plausible turn: add `--json` to a CLI, then verify it.
// ---------------------------------------------------------------------------
thinking("I'll find the CLI entry point and see how flags are parsed.", 2400);
tool("read", { path: "src/cli.ts", offset: 1 }, "exploring", "import { parseArgs } from \"./args\";\n… 38 lines", 640);
tool("grep", { pattern: "parseArgs|--json", path: "src" }, "exploring", "src/cli.ts:42:  const args = parseArgs(process.argv);\nsrc/args.ts:7: export function parseArgs…", 410);
tool("ls", { path: "docs" }, "exploring", "cli.md\nindex.md\napi.md", 180);
    // No activity (a plugin that has not opted in): joins the running group instead.
    tool("web_search", { query: "bun parseArgs boolean flag docs" }, undefined, "\u2713 3 sources", 900);

prose("The parser is hand-rolled in `src/args.ts`. I'll add the flag there and document it.");

thinking("Add the field, thread it into the JSON renderer, then run the suite.", 3100);
tool("edit", { path: "src/args.ts" }, "implementing", "44 ++++++++++----\n2 removed", 1520);
tool("write", { path: "docs/cli.md", content: Array.from({ length: 18 }, (_, i) => `line ${i + 1}`).join("\n") }, "implementing", "+18 -0\n1 file changed", 700);

tool("bash", { command: "bun test" }, "testing", "1 fail\n11 pass\nexpected(received).toBe(true)", 2600, true);
tool("edit", { path: "src/args.ts" }, "testing", "+2 -1", 800);
tool("bash", { command: "bun test" }, "testing", "12 pass\n0 fail", 2100);
tool("code_execution", { code: "import json\nout = bash('bun run src/cli.ts --json')\nprint(json.loads(out)['ok'])" }, "testing", "", 1400);

prose("`--json` now prints `{\"ok\": true, …}`; docs updated and the suite is green.");
thinking("Done \u2014 summarising the change for the user.", 1200);

// Strip CSI colors and OSC 133 copy-zone markers so the sample reads as plain text.
    const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]133;[ABC](?:\x07|\x1b\\)?/g, "").trimEnd();

    // `--shimmer-strip[=N]` renders one running group at N successive clock values so the
    // label sweep can be eyeballed (run it with --color in a real terminal).
    const stripArg = process.argv.find((a) => a.startsWith("--shimmer-strip"));
    if (stripArg) {
	const frames = Number(stripArg.split("=")[1] ?? 6) || 6;
	for (const handler of handlers.get("agent_start") ?? []) await handler({}, ui);
	const probe = new Container();
	const running = startTool("read", { path: "src/args.ts" }, "implementing");
	running.component.updateResult({ content: [{ type: "text", text: "…" }], isError: false } as any, true);
	probe.addChild(running.component);
	const paint = COLOR ? (l: string) => l : plain;
	process.stdout.write(probe.render(WIDTH).map(paint).join("\n") + "\n");
	for (let i = 1; i < frames; i++) {
		advance(400);
		process.stdout.write(probe.render(WIDTH).map(paint).join("\n") + "\n");
	}
	process.exit(0);
    }

    process.stdout.write(root.render(WIDTH).map(COLOR ? (l: string) => l : plain).join("\n") + "\n");
