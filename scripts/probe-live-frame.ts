/**
 * Does a grouped, still-running tool arm the fast (80ms) repaint that drives the
 * label shimmer? Renders the real transcript path with setTimeout captured.
 *
 *   bun scripts/probe-live-frame.ts
 */
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { initTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import extension from "../extensions/index.ts";

initTheme("dark", false);
const handlers = new Map<string, any[]>();
const pi = { registerTool() {}, registerCommand() {}, registerShortcut() {}, on(n: string, h: any) { handlers.set(n, [...(handlers.get(n) ?? []), h]); } };
const realHome = process.env.HOME;
process.env.HOME = `${realHome}/.pi-timer-probe-${Date.now()}`;
extension(pi as any);
process.env.HOME = realHome;

for (const handler of handlers.get("agent_start") ?? []) { try { await handler({}, { hasUI: false }); } catch { /* noop */ } }

const delays: Array<number | undefined> = [];
const realSetTimeout = globalThis.setTimeout;
(globalThis as any).setTimeout = (fn: any, ms?: number, ...rest: any[]) => {
	delays.push(ms);
	return { unref() {}, ref() {}, hasRef: () => false } as any;
};

const ui = { requestRender() {} };
function render(component: ToolExecutionComponent, label: string) {
	delays.length = 0;
	const root = new Container();
	root.addChild(component);
	root.render(100);
	console.log(`${label}: scheduled timeouts [${delays.join(", ")}]`);
}

// (a) plain pending tool: no partial result, no live preview
const readDef = { name: "read", label: "read", description: "r", parameters: {}, renderResult: () => ({ invalidate() {}, render: () => ["out"] }) };
const plainPending = new ToolExecutionComponent("read", "plain", { path: "src/x.ts", activity: "exploring" }, {}, readDef as any, ui as any, process.cwd());
plainPending.markExecutionStarted();
plainPending.updateResult({ content: [{ type: "text", text: "…" }], isError: false } as any, true);
render(plainPending, "pending read (no preview)");

// (b) bash-style pending tool with partial output (live preview path)
const bashDef = {
	name: "bash", label: "bash", description: "b", parameters: {},
	renderResult(_r: any, { isPartial }: any) { return new Text(isPartial ? "running…" : "done", 0, 0); },
};
const streaming = new ToolExecutionComponent("bash", "stream", { command: "bun test", activity: "testing" }, {}, bashDef as any, ui as any, process.cwd());
streaming.markExecutionStarted();
streaming.updateResult({ content: [{ type: "text", text: "1 fail\n11 pass" }], isError: false } as any, true);
render(streaming, "pending bash (partial output)");

(globalThis as any).setTimeout = realSetTimeout;
