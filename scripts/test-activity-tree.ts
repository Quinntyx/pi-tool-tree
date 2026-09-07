import assert from "node:assert/strict";
import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import { initTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import extension from "../extensions/index.ts";

initTheme("dark", false);
const handlers = new Map<string, any[]>();
const tools = new Map<string, any>();
const pi = {
	registerTool(tool: any) { tools.set(tool.name, tool); },
	registerCommand() {}, registerShortcut() {},
	on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
};
extension(pi as any);
for (const handler of handlers.get("agent_start") ?? []) await handler({}, {});
const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
const ui = { requestRender() {} };
let frame = 1;
let nativeRenders = 0;
const definition = {
	name: "code_execution", label: "Code Execution", description: "Test native animation", parameters: {},
	renderResult(_result: any, { isPartial }: any) {
		nativeRenders++;
		return { invalidate() {}, render: () => [isPartial ? `Executing Python frame ${frame}` : "completed output", "  ▶ preserved indentation"] };
	},
};
function tool(id: string, code = "print('same')", finished = false, isError = false) {
	const component = new ToolExecutionComponent("code_execution", id, { code }, {}, definition as any, ui as any, process.cwd());
	component.markExecutionStarted();
	component.updateResult({ content: [{ type: "text", text: "raw fallback must not replace animation" }], isError } as any, !finished);
	return component;
}
const parent = new Container();
const first = tool("one", undefined, true);
const second = tool("two");
parent.addChild(first);
parent.addChild(second);
let output = plain(parent.render(100));
assert.equal(parent.children.length, 2, "grouping must not move original components");
assert.equal(output.split("\n").filter((line) => /[├╰] .*Code Execution/.test(line)).length, 2);
assert.ok(output.includes("Executing Python frame 1"));
assert.ok(!output.includes("×2"));
assert.ok(!output.includes("Code Execution Code Execution"));
assert.ok(!output.split("\n").some((line) => /^\s*─{5,}\s*$/.test(line)));
frame = 2;
output = plain(parent.render(100));
assert.ok(output.includes("Executing Python frame 2"), "live frame must not be cached");
second.updateResult({ content: [{ type: "text", text: "done" }], isError: false } as any, false);
output = plain(parent.render(100));
assert.ok(!output.includes("Executing Python") && !output.includes("completed output"), "finished native output should collapse");
second.setExpanded(true);
assert.ok(plain(parent.render(100)).includes("completed output"), "Ctrl+O must reveal native output");
second.setExpanded(false);
assert.ok(nativeRenders > 0);

const thought = {
	role: "assistant", content: [{ type: "thinking", thinking: "Reasoning about 界 and 👩‍💻" }], stopReason: "pending",
	_piClaudeStyleThinkingActive: true,
};
const assistant = new AssistantMessageComponent(thought as any, false);
assistant.updateContent(thought as any, true);
parent.addChild(assistant);
output = plain(parent.render(100));
assert.ok(output.includes("╰ Thinking…"));
assert.ok(output.includes("Reasoning about"));
const after = structuredClone(thought) as any;
after.stopReason = "toolUse";
after._piClaudeStyleThinkingActive = false;
after._piClaudeStyleThinkingDurationMs = 2400;
assistant.updateContent(after, false);
parent.addChild(tool("three", "print('third')", true, true));
output = plain(parent.render(100));
assert.ok(output.includes("├ Thought for"));
assert.ok(output.split("\n").some((line) => /^ [├╰] ✓ Code Execution/.test(line)), "success uses a checkmark");
assert.ok(output.split("\n").some((line) => /^ [├╰] ! Code Execution/.test(line)), "failure uses an exclamation mark");
assert.ok(!output.includes("✓ ✓") && !output.includes("! !"), "status markers must not be duplicated");
assert.ok(!output.includes("Reasoning about"), "completed thinking collapses by default");
assert.equal(output.split("\n").filter((line) => /[├╰] .*Code Execution/.test(line)).length, 3);
assistant.setHideThinkingBlock(false);
const expandedOutput = plain(parent.render(100));
assert.ok(expandedOutput.includes("Reasoning about"), "Ctrl+T still expands thoughts");
// Every thinking body line must carry the gray color (the ∴-gutter slice used to
// drag its ANSI reset onto the first line, turning it black).
const gray = "\x1b[38;2;";
for (const line of parent.render(100)) {
	if (line.includes("Reasoning about") && !line.includes(gray)) {
		throw new Error(`thinking body line lost its gray color: ${JSON.stringify(line)}`);
	}
}
assistant.setHideThinkingBlock(true);
assert.ok(!plain(parent.render(100)).includes("Reasoning about"));
assert.deepEqual(thought.content, [{ type: "thinking", thinking: "Reasoning about 界 and 👩‍💻" }], "grouping must not mutate message content");

const mixed = new AssistantMessageComponent({
	role: "assistant", stopReason: "stop", _piClaudeStyleThinkingDurationMs: 1000,
	content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "Visible answer stays after the tree." }],
} as any);
parent.addChild(mixed);
output = plain(parent.render(100));
assert.ok(output.lastIndexOf("Visible answer") > output.lastIndexOf("Thought for"));
// Prose keeps its original spacing (no injected blank lines) and its dot follows the tree gray.
assert.ok(output.split("\n").some((line) => / ● /.test(line)), "prose paragraph dot present");
assert.equal(plain(parent.render(100)), output, "repeated rendering must not accumulate spacing");
const terminal = new Text("User boundary", 0, 0);
parent.addChild(terminal);
parent.addChild(tool("four", "print('next')", true));
output = plain(parent.render(100));
assert.ok(output.indexOf("User boundary") < output.indexOf("print('next')"));
// Malformed numeric path arguments must not crash rendering (glm-5.3-flash produced path: 5).
const numeric = new ToolExecutionComponent("read", "bad-args", { path: 5, offset: 1 } as any, {}, undefined as any, ui as any, process.cwd());
numeric.markExecutionStarted();
numeric.updateResult({ content: [{ type: "text", text: "ok" }], isError: false } as any, false);
parent.addChild(numeric);
assert.doesNotThrow(() => plain(parent.render(100)), "numeric path args must not crash");
for (const width of [1, 2, 4, 8, 20, 60, 100, 145]) {
	for (const line of parent.render(width)) assert.ok(visibleWidth(line) <= width, `overflow at ${width}: ${visibleWidth(line)}`);
}
// Default Markdown bullets are untouched (no ◉ takeover).
const listMessage = new AssistantMessageComponent({
	role: "assistant", stopReason: "stop",
	content: [{ type: "text", text: "- first item\n- second item" }],
} as any);
const listParent = new Container();
listParent.addChild(listMessage);
const listOutput = plain(listParent.render(100));
assert.ok(!listOutput.includes("◉"), "stock list bullets must not be replaced");
assert.ok(listOutput.includes("first item"));
// Light-mode tree connectors are quieter without fading the reasoning text.
initTheme("light", false);
const ctx = { hasUI: true, ui: { theme, notify() {}, getToolsExpanded: () => false, setToolsExpanded() {} } };
for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "resume" }, ctx);
const lightTree = parent.render(100);
assert.ok(lightTree.some((line) => line.includes("\x1b[38;2;176;176;176m├")), "light gray connectors on a light background");
console.log("OK: spacing reverted, gray prose dots, stock bullets, short connectors, ✓/! statuses, live previews, and width safety");
