import assert from "node:assert/strict";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { initTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import extension from "../extensions/index.ts";

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
// Isolate settings the same way test-activity-tree.ts does: the activity param and
// preview limits read `~/.pi/settings.json`.
const realHome = process.env.HOME;
process.env.HOME = `${realHome}/.pi-streaming-args-test-${Date.now()}`;
extension(pi as any);

const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
const ui = { requestRender() {} };

const bashTool = tools.get("bash");
assert.ok(bashTool, "bash must be registered");
assert.equal(typeof bashTool.renderCall, "function", "bash keeps its own call renderer");

let callSeq = 0;
function bashRow(command: string, activity?: string) {
	const args: Record<string, string> = { command };
	if (activity) args.activity = activity;
	return new ToolExecutionComponent("bash", `stream-${++callSeq}`, args, {}, bashTool as any, ui as any, process.cwd());
}
function renderRow(component: any, width = 100): string {
	const parent = new Container();
	parent.addChild(component);
	return plain(parent.render(width));
}

// A live run: currentAgentWorkStartMs is set, so args can legitimately stream.
for (const handler of handlers.get("agent_start") ?? []) await handler({}, {});

// While the model is still writing the arguments, a multiline command grows a
// full block token by token — not the compact one-line headline.
{
	const out = renderRow(bashRow(`cd /tmp\necho "stream`));
	assert.ok(out.includes("cd /tmp"), `streaming block shows every partial line: ${JSON.stringify(out)}`);
	assert.ok(out.includes('echo "stream'), "the partial tail line is present");
	assert.ok(out.includes("▌"), "the streaming block carries a typing cursor");
	assert.ok(!out.includes("checking"), "sanity: no unrelated content");
}

// Growing args repaint the block on the next frame.
{
	const growing = bashRow('echo "one');
	assert.ok(renderRow(growing).includes('echo "one'), "initial partial args render");
	growing.updateArgs({ command: 'echo "one two"' });
	assert.ok(renderRow(growing).includes('echo "one two'), "updated args repaint the streaming block");
}

// A single-line command streams through the header's own headline — a one-line
// block would only repeat it, so no block and no cursor.
{
	const out = renderRow(bashRow("echo streaming-one-liner"));
	assert.ok(!out.includes("▌"), "single-line commands stream without a block");
}

// While the call runs, the whole command stays visible — the 8-line preview cap
// only applies to collapsed error rows.
const script = Array.from({ length: 12 }, (_, i) => `echo step-${i + 1}`).join("\n");
const running = bashRow(script);
running.setArgsComplete();
running.markExecutionStarted();
{
	const out = renderRow(running);
	assert.ok(out.includes("echo step-11"), `the full command stays visible while running: ${JSON.stringify(out)}`);
	assert.ok(!out.includes("more command lines"), "the running block is not capped at the 8-line preview");
}

// Once the call settles, the row collapses back to its one-line headline.
running.updateResult({ content: [{ type: "text", text: "all done" }], isError: false } as any, false);
{
	const out = renderRow(running);
	assert.ok(!out.includes("echo step-11"), "settled success drops the command block");
	assert.ok(!out.includes("▌"), "no cursor after settlement");
}

// Failed commands keep the collapsed 8-line preview in the native (non-grouped)
// render; the grouped tree collapses settled rows to their one-liner either way.
{
	const failing = bashRow(script);
	failing.setArgsComplete();
	failing.markExecutionStarted();
	failing.updateResult({ content: [{ type: "text", text: "boom" }], isError: true } as any, false);
	const native = plain(failing.render(90));
	assert.ok(native.includes("echo step-7"), `failed commands keep the native preview: ${JSON.stringify(native)}`);
	assert.ok(!native.includes("echo step-8"), "the failed preview stays capped at 8 lines");
	const out = renderRow(failing);
	assert.ok(!out.includes("echo step-7"), "the grouped tree collapses the settled failure to its one-liner");
}

// After agent_end, reconstructed history rows (isPartial, never executed) must
// not fake a streaming block — and the streaming phase keeps its pending light.
for (const handler of handlers.get("agent_end") ?? []) await handler({}, {});
{
	const out = renderRow(bashRow('echo "stream'));
	assert.ok(!out.includes("▌"), "no fake streaming cursor for history rows");
	assert.ok(!out.includes("cd /tmp"), "history rows render the compact headline, not a block");
}

// A rambling activity label is cut on a word boundary, never mid-word
// ("checking the ptc streaming u" was the failure mode).
{
	const out = renderRow(bashRow("echo hi", "checking the ptc streaming usage"));
	assert.ok(out.includes("checking the ptc"), `the label truncates on a word boundary: ${JSON.stringify(out)}`);
	assert.ok(!/\bstreaming\b/.test(out), "the truncated words are dropped, not cut in half");
}

console.log("OK  streaming args: token-by-token block, full command while running, settled collapse, history safety, word-boundary labels");
