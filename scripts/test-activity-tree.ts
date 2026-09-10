import assert from "node:assert/strict";
import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import { initTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import extension from "../extensions/index.ts";

initTheme("dark", false);
const handlers = new Map<string, any[]>();
const commands = new Map<string, any>();
const tools = new Map<string, any>();
const pi = {
	registerTool(tool: any) { tools.set(tool.name, tool); },
	registerCommand(name: string, command: any) { commands.set(name, command); }, registerShortcut() {},
	on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
};
// Isolate settings: the activity param reads `toolActivityParam` from ~/.pi/settings.json.
const realHome = process.env.HOME;
const tmpHome = `${realHome}/.pi-activity-test-home-${Date.now()}`;
process.env.HOME = tmpHome;
extension(pi as any);
for (const handler of handlers.get("agent_start") ?? []) await handler({}, {});
const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
const ui = { requestRender() {} };
let frame = 1;
let nativeRenders = 0;
const definition = {
	name: "code_execution", label: "python", description: "Test native animation", parameters: {},
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
assert.equal(output.split("\n").filter((line) => /[├╰] .*python/.test(line)).length, 2);
assert.ok(output.includes("Executing Python frame 1"));
// Neither tool declares `activity`, so the group has nothing to inherit: it falls
// back to the default label instead of printing a bare `2 calls` header.
assert.ok(output.split("\n").some((line) => /^ [\u2800-\u28FF●] working 2 calls/.test(line)), `unlabeled first group must show the default label: ${JSON.stringify(output.split("\n")[0])}`);
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
assert.ok(output.split("\n").some((line) => /^ [├╰] ✓ python/.test(line)), "success uses a checkmark");
assert.ok(output.split("\n").some((line) => /^ [├╰] ! python/.test(line)), "failure uses an exclamation mark");
assert.ok(!output.includes("✓ ✓") && !output.includes("! !"), "status markers must not be duplicated");
assert.ok(!output.includes("Reasoning about"), "completed thinking collapses by default");
assert.equal(output.split("\n").filter((line) => /[├╰] .*python/.test(line)).length, 3);
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
// Prose renders flush left with Pi's own Markdown child: no dot, no indent, and a
// blank line separates it from the activity groups around it. (Group headers keep
// their own status dot, so only the prose lines themselves are checked here.)
const proseLines = output.split("\n").filter((line) => line.includes("Visible answer"));
assert.equal(proseLines.length, 1);
assert.ok(/^ ?Visible answer/.test(proseLines[0]), `prose must be flush left without a dot: ${JSON.stringify(proseLines[0])}`);
assert.ok(!/\b0 calls?\b/.test(output), "a group with no tool calls must not print a count header");
assert.equal(plain(parent.render(100)), output, "repeated rendering must not accumulate spacing");
// Thinking hidden up front (pi's hideThinkingBlock / Ctrl+T) must never stream a
// live body — only the one-line summary stays until the user expands it.
const hiddenMessage = {
	role: "assistant", content: [{ type: "thinking", thinking: "secret live reasoning" }], stopReason: "pending",
	_piClaudeStyleThinkingActive: true,
};
const hiddenStream = new AssistantMessageComponent(hiddenMessage as any, true);
hiddenStream.updateContent(structuredClone(hiddenMessage) as any, true);
const hiddenParent = new Container();
hiddenParent.addChild(hiddenStream);
const hiddenOutput = plain(hiddenParent.render(100));
assert.ok(!hiddenOutput.includes("secret live reasoning"), "hidden thinking must not stream");
assert.ok(/Thinking…|Thought for/.test(hiddenOutput), "hidden thinking still reports a summary line");
const terminal = new Text("User boundary", 0, 0);
parent.addChild(terminal);
parent.addChild(tool("four", "print('next')", true));
output = plain(parent.render(100));
assert.ok(output.indexOf("User boundary") < output.indexOf("print('next')"));
// Prose is followed by exactly one blank line before the next transcript block.
assert.ok(/Visible answer stays after the tree\. *\n\n ?User boundary/.test(output), "prose must be followed by exactly one blank line");
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

// User messages keep their own bubble: pi pads them with background-filled rows
// inside a Box, and the transcript must not trim those away (it only trims the
// Spacer padding that pi puts around assistant messages).
{
	const chat = new Container();
	const anchorTool = new ToolExecutionComponent("code_execution", "bubble-anchor", { code: "print(1)", activity: "testing" }, {}, definition as any, ui as any, process.cwd());
	anchorTool.markExecutionStarted();
	anchorTool.updateResult({ content: [{ type: "text", text: "ok" }], isError: false } as any, false);
	chat.addChild(anchorTool);
	const userMessage: any = new UserMessageComponent("hello bubble");
	chat.addChild(userMessage);
	const lines = chat.render(100);
	const textIndex = lines.findIndex((line) => line.replace(/\x1b\[[0-9;]*m/g, "").includes("hello bubble"));
	assert.ok(textIndex > 0, "the user message must render inside the transcript");
	// A padding row is visually empty but background-filled; trimming it collapses the bubble.
	const isPaddingRow = (line: string | undefined) => Boolean(line)
		&& /\x1b\[48;2;\d+;\d+;\d+m/.test(line as string)
		&& (line as string).replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "").trim() === "";
	assert.ok(isPaddingRow(lines[textIndex - 1]), `user bubble keeps its top padding row: ${JSON.stringify(lines[textIndex - 1])}`);
	assert.ok(isPaddingRow(lines[textIndex + 1]), `user bubble keeps its bottom padding row: ${JSON.stringify(lines[textIndex + 1])}`);
}

// Pending lights are a braille spinner by default, indexed off the wall clock, and
// `/cc-tools pending dot` still offers the classic blinking ●.
{
	const realNow = Date.now;
	let fakeNow = 1_700_000_000_000;
	Date.now = () => fakeNow;
	const frames = "⠃⠉⠘⠰⢠⣀⡄⠆";
	const ctx = { hasUI: true, ui: { theme, notify() {}, getToolsExpanded: () => false, setToolsExpanded() {} } };
	const glyphOf = (parent: Container) => {
		const line = plain(parent.render(100)).split("\n").find((l) => l.includes("implementing")) ?? "";
		return line[1] ?? "";
	};
	const pendingTool = (id: string) => {
		const parent = new Container();
		const component = new ToolExecutionComponent("code_execution", id, { code: "print(1)", activity: "implementing" }, {}, definition as any, ui as any, process.cwd());
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "ok" }], isError: false } as any, true);
		parent.addChild(component);
		return { parent, component };
	};
	try {
		const spinning = pendingTool("spinner-frame");
		const first = glyphOf(spinning.parent);
		assert.ok(frames.includes(first), `a pending group must spin: ${JSON.stringify(first)}`);
		fakeNow += 80;
		const second = glyphOf(spinning.parent);
		assert.notEqual(second, first, "the spinner frame must advance with the clock");
		assert.ok(frames.includes(second), `spinner frames stay in the cycle: ${JSON.stringify(second)}`);
		// Settled groups show the static filled light (green ●), never a spinner frame.
		spinning.component.updateResult({ content: [{ type: "text", text: "ok" }], isError: false } as any, false);
		assert.equal(glyphOf(spinning.parent), "●", "a settled group shows the static status light");

		const dotCase = pendingTool("spinner-dot");
		await commands.get("cc-tools").handler("pending dot", ctx);
		assert.ok("● ".includes(glyphOf(dotCase.parent)), `dot mode must blink, not spin: ${JSON.stringify(glyphOf(dotCase.parent))}`);
		await commands.get("cc-tools").handler("pending spinner", ctx);
		assert.ok(frames.includes(glyphOf(dotCase.parent)), "spinner mode comes back with /cc-tools pending spinner");
	} finally {
		Date.now = realNow;
	}
}

// The transcript arms its own repaint while a group runs: grouped rows bypass the
// native tool renderer that would otherwise arm the ● blink / shimmer tick. The frame
// must also *request* a render — pi's component invalidate only clears caches, so a
// loop that just invalidates paints nothing (the bug that made the shimmer invisible).
{
	await new Promise((resolve) => setTimeout(resolve, 150));
	const realSetTimeout = globalThis.setTimeout;
	const frames: Array<() => void> = [];
	const delays: Array<number | undefined> = [];
	(globalThis as any).setTimeout = ((fn: any, ms?: number) => {
		delays.push(ms);
		if (typeof fn === "function") frames.push(fn);
		return { unref() {}, ref() {}, hasRef: () => false } as any;
	});
	try {
		const renders = { count: 0 };
		const cadenceParent = new Container();
		const tool = new ToolExecutionComponent(
			"code_execution", "cadence", { code: "print(1)", activity: "implementing" }, {}, definition as any,
			{ requestRender: () => { renders.count++; } } as any, process.cwd(),
		);
		tool.markExecutionStarted();
		tool.updateResult({ content: [{ type: "text", text: "ok" }], isError: false } as any, true);
		cadenceParent.addChild(tool);
		cadenceParent.render(100);
		assert.ok(delays.includes(80), `a running group must arm the ~80ms repaint: ${JSON.stringify(delays)}`);
		const armed = frames.slice();
		assert.ok(armed.length > 0, "a frame callback must be armed");
		// Ignore the requests that setup made (markExecutionStarted requests one itself).
		renders.count = 0;
		for (const frame of armed) frame();
		assert.ok(renders.count > 0, "each frame must request a repaint, not just clear caches");
	} finally {
		(globalThis as any).setTimeout = realSetTimeout;
	}
}

// A running group's total ticks live off the wall clock, and freezes when it settles.
{
	const realNow = Date.now;
	let fakeNow = 1_700_000_000_000;
	Date.now = () => fakeNow;
	try {
		const liveParent = new Container();
		const callId = "live-timer";
		for (const handler of handlers.get("tool_execution_start") ?? []) {
			await handler({ toolCallId: callId, toolName: "code_execution", args: { code: "print(1)", activity: "testing" } }, ui);
		}
		const running = new ToolExecutionComponent("code_execution", callId, { code: "print(1)", activity: "testing" }, {}, definition as any, ui as any, process.cwd());
		running.markExecutionStarted();
		running.updateResult({ content: [{ type: "text", text: "running" }], isError: false } as any, true);
		liveParent.addChild(running);
		assert.ok(/testing 1 call · <1s/.test(plain(liveParent.render(100))), "a just-started group starts near zero");
		fakeNow += 5000;
		assert.ok(/testing 1 call · 5s/.test(plain(liveParent.render(100))), `a running total must tick: ${JSON.stringify(plain(liveParent.render(100)).split("\n")[0])}`);
		fakeNow += 4000;
		assert.ok(/testing 1 call · 9s/.test(plain(liveParent.render(100))), "a running total keeps ticking");
		// Settle it: the total now measures the recorded run and stops moving.
		for (const handler of handlers.get("tool_execution_end") ?? []) {
			await handler({ toolCallId: callId, toolName: "code_execution", args: {} }, ui);
		}
		running.updateResult({ content: [{ type: "text", text: "done" }], isError: false } as any, false);
		const settled = plain(liveParent.render(100));
		fakeNow += 30000;
		assert.equal(settled, plain(liveParent.render(100)), "a settled total must stop ticking");
	} finally {
		Date.now = realNow;
	}
}

// A group that reasoned for 19s and then ran a fast tool must not advertise `<1s`:
// thinking is time spent on the group even though it is not a call.
{
	const reasoned = new Container();
	const thinkingMessage = {
		role: "assistant", stopReason: "toolUse", _piClaudeStyleThinkingActive: false, _piClaudeStyleThinkingDurationMs: 19000,
		content: [{ type: "thinking", thinking: "long private reasoning" }],
	} as any;
	const asm = new AssistantMessageComponent(thinkingMessage, false);
	asm.updateContent(thinkingMessage, false);
	reasoned.addChild(asm);
	const fast = new ToolExecutionComponent("code_execution", "duration-case", { code: "print(1)", activity: "exploring" }, {}, definition as any, ui as any, process.cwd());
	fast.markExecutionStarted();
	fast.updateResult({ content: [{ type: "text", text: "ok" }], isError: false } as any, false);
	reasoned.addChild(fast);
	const reasonedOutput = plain(reasoned.render(100));
	assert.ok(reasonedOutput.includes("├ Thought for 19s"), `thought row keeps its own duration: ${JSON.stringify(reasonedOutput)}`);
	assert.ok(/exploring 1 call · 19s/.test(reasonedOutput), `group duration must include thinking time: ${JSON.stringify(reasonedOutput.split("\n")[0])}`);
	assert.ok(!/exploring 1 call · <1s/.test(reasonedOutput), "group duration must not ignore thinking");
}

// Running groups shimmer: the label carries a moving multi-color gradient that stops
// once every call settles (and the label text itself never changes).
{
	const realNow = Date.now;
	let fakeNow = 1_700_000_000_000;
	Date.now = () => fakeNow;
	try {
		const shimmerParent = new Container();
		const pendingTool = new ToolExecutionComponent("code_execution", "shimmer-pending", { code: "print(1)", activity: "implementing" }, {}, definition as any, ui as any, process.cwd());
		pendingTool.markExecutionStarted();
		pendingTool.updateResult({ content: [{ type: "text", text: "ok" }], isError: false } as any, true);
		shimmerParent.addChild(pendingTool);
		const codeSet = (lines: string[]) => new Set([...lines.join("\n").matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map((m) => m[0]));
		// Colors that belong to the label itself: the one opening it plus any interleaved
		// between its characters (the dot/branch colors before it are not ours).
		// The gradient interleaves color codes between the label's characters, so the
		// label is not a contiguous substring of the raw line: strip first, then take
		// every color between the status glyph (spinner while running) and the counts.
		const labelColors = (lines: string[]) => {
			const line = lines.find((l) => l.replace(/\x1b\[[0-9;]*m/g, "").includes("implementing")) ?? "";
			const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
			const glyphAt = stripped.search(/[\u2800-\u28FF●]/);
			const callAt = line.indexOf("1 call");
			if (glyphAt < 0 || callAt < 0) return [];
			const region = line.slice(glyphAt + 1, callAt);
			return [...region.matchAll(/\x1b\[38;2;\d+;\d+;\d+m/g)].map((m) => m[0]);
		};
		const firstFrame = shimmerParent.render(100);
		assert.ok(/implementing/.test(plain(firstFrame)), "the label text survives the gradient");
		assert.ok(new Set(labelColors(firstFrame)).size >= 3, `a running label must be a gradient, got ${new Set(labelColors(firstFrame)).size} colors`);
		fakeNow += 250;
		const secondFrame = shimmerParent.render(100);
		assert.notEqual(labelColors(firstFrame).join(), labelColors(secondFrame).join(), "the running label must animate between frames");
		// Settled groups keep a constant label: no gradient, and no motion over time.
		pendingTool.updateResult({ content: [{ type: "text", text: "ok" }], isError: false } as any, false);
		const settled = shimmerParent.render(100);
		assert.ok(new Set(labelColors(settled)).size <= 1, `a settled label must not keep gradient colors: ${JSON.stringify(labelColors(settled))}`);
		fakeNow += 250;
		assert.equal(settled.join("\n"), shimmerParent.render(100).join("\n"), "a settled label must not animate");
	} finally {
		Date.now = realNow;
	}
}
// Light-mode tree connectors are quieter without fading the reasoning text.
initTheme("light", false);
const ctx = { hasUI: true, ui: { theme, notify() {}, getToolsExpanded: () => false, setToolsExpanded() {} } };
for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "resume" }, ctx);
const lightTree = parent.render(100);
assert.ok(lightTree.some((line) => line.includes("\x1b[38;2;176;176;176m├")), "light gray connectors on a light background");
console.log("OK: flush-left prose, blank-line block spacing, tool-only call counts, hidden-thinking respect, stock bullets, short connectors, ✓/! statuses, live previews, and width safety");
// ---------------------------------------------------------------------------
// Activity param: the core tools opt in, other plugins opt in through the
// published integration, and /cc-tools activity switches it without a restart.
// ---------------------------------------------------------------------------
{
	const api = (globalThis as any)[Symbol.for("pi-tool-tree:activity-api")];
	assert.ok(api, "the activity integration must be published on globalThis");
	assert.equal(api.version, 1);
	assert.equal(api.param, "activity");
	assert.equal(api.defaultLabel, "working");
	assert.equal(api.enabled(), true);

	// Core tools declare the param, so the model always sees it in the schema — as an
	// optional property. Marking it required broke third-party validators that mirror
	// the advertised schema (pi-ptc-next validates its Python callables with it and
	// rejected every call that omitted the label).
	for (const name of ["read", "bash", "grep", "find", "ls", "write", "edit"]) {
		const tool = tools.get(name);
		assert.ok(tool?.parameters?.properties?.activity, `${name} schema must accept activity`);
		assert.ok(!tool.parameters.required.includes("activity"), `${name} must not require activity (breaks mirrored validators)`);
	}

	// Plugin opt-in: schema gains the param, a missing label defaults, and the
	// plugin's own execute never sees it. Recorded (model) args are not mutated.
	const seen: any[] = [];
	const pluginTool = api.wrapTool({
		name: "plugin_probe",
		parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
		async execute(_id: string, args: any) { seen.push(args); return { content: [], details: {} }; },
	});
	assert.ok(pluginTool.parameters.properties.activity, "plugin schema must accept activity");
	const rawArgs = { value: "v" };
	assert.equal(pluginTool.prepareArguments(rawArgs).activity, "working", "a missing label must default");
	assert.deepEqual(rawArgs, { value: "v" }, "prepareArguments must not mutate the model's args");
	await pluginTool.execute("id", { value: "v", activity: "exploring" });
	assert.deepEqual(seen, [{ value: "v" }], "execute must never see the label");
	assert.equal(pluginTool[Symbol.for("pi-tool-tree:activity-wrapped")], true, "wrapping is idempotent");

	// The real validator must accept the injected param without losing strictness
	// (a missing required arg still fails).
	const { validateToolArguments } = await import("../node_modules/@earendil-works/pi-ai/dist/utils/validation.js");
	const readTool = tools.get("read");
	const validated = validateToolArguments(readTool, { id: "c1", name: "read", arguments: { path: "x", activity: "exploring" } } as any);
	assert.equal(validated.activity, "exploring");
	assert.equal(validated.path, "x");
	const defaulted = validateToolArguments(readTool, { id: "c2", name: "read", arguments: readTool.prepareArguments({ path: "x" }) } as any);
	assert.equal(defaulted.activity, "working");
	const unlabeled = validateToolArguments(readTool, { id: "c2b", name: "read", arguments: { path: "x" } } as any);
	assert.equal(unlabeled.path, "x", "a validator that mirrors the schema must accept a missing label");
	assert.throws(
		() => validateToolArguments(readTool, { id: "c3", name: "read", arguments: { activity: "exploring" } } as any),
		/Validation failed/,
		"required arguments must still be enforced",
	);

	// Disabling drops the param from the core tools and makes wrapTool a no-op.
	const ccTools = commands.get("cc-tools");
	assert.ok(ccTools, "cc-tools command must be registered");
	const toolCtx = { hasUI: true, ui: { theme, notify() {}, getToolsExpanded: () => false, setToolsExpanded() {} } };
	await ccTools.handler("activity off", toolCtx);
	assert.equal(api.enabled(), false);
	assert.equal(api.wrapTool({ name: "x", parameters: { type: "object", properties: {} }, execute: async () => ({}) }).parameters.properties.activity, undefined);
	assert.equal(tools.get("read").parameters.properties.activity, undefined, "activity off must drop the param");
	await ccTools.handler("activity on", toolCtx);
	assert.ok(tools.get("read").parameters.properties.activity, "activity on must restore the param");
	console.log("OK  activity param: core tools, plugin opt-in, /cc-tools toggle, disabled no-op");
}

process.env.HOME = realHome;
const { execFileSync } = await import("node:child_process");
execFileSync("trash", [tmpHome]);
