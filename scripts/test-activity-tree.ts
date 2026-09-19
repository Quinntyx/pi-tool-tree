import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
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
assert.ok(output.split("\n").some((line) => /^ [●•· \u2800-\u28FF] working 2 calls/.test(line)), `unlabeled first group must show the default label: ${JSON.stringify(output.split("\n")[0])}`);
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

// File mutations keep their model-authored preview visible after settlement. When a
// later call follows in the same cluster, the outer rail must continue beside every
// preview row rather than stopping at the edit/write heading.
{
	const mutationDefinition = (name: "edit" | "write") => ({
		name,
		label: name,
		description: `${name} fixture`,
		parameters: {},
		renderCall: () => new Text(`${name} src/example.ts`, 0, 0),
		renderResult: () => new Text("preview line one\npreview line two", 0, 0),
	});
	const mutation = (name: "edit" | "write", id: string) => {
		const component = new ToolExecutionComponent(name, id, { path: "src/example.ts", activity: "implementing" }, {}, mutationDefinition(name) as any, ui as any, process.cwd());
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false } as any, false);
		return component;
	};
	const cluster = new Container();
	cluster.addChild(mutation("edit", "persistent-edit"));
	cluster.addChild(mutation("write", "persistent-write"));
	cluster.addChild(tool("after-mutations", "print('verify')", true));
	const mutationLines = plain(cluster.render(100)).split("\n");
	assert.equal(mutationLines.filter((line) => line.includes("preview line one")).length, 2, "settled edit and write previews stay visible");
	for (const previewLine of mutationLines.filter((line) => line.includes("preview line"))) {
		assert.match(previewLine, /^ │\s+/, `the cluster rail must continue beside mutation previews: ${JSON.stringify(previewLine)}`);
	}
	const pendingCluster = new Container();
	const pendingWriteContent = readFileSync("config/config.example.json", "utf8").replace(
		'"diffSplitMinWidth": 132',
		'"diffSplitMinWidth": 144,\n  "previewOnly": true,\n  "previewLayout": "split"',
	);
	const pendingWriteArgs = { path: "config/config.example.json", content: pendingWriteContent, activity: "implementing" };
	const pendingWrite = new ToolExecutionComponent(
		"write",
		"pending-write-preview",
		pendingWriteArgs,
		{},
		tools.get("write") as any,
		ui as any,
		process.cwd(),
	);
	pendingWrite.updateArgs(pendingWriteArgs);
	pendingWrite.setArgsComplete();
	pendingWrite.markExecutionStarted();
	pendingWrite.updateResult({ content: [{ type: "text", text: "" }], isError: false } as any, true);
	pendingCluster.addChild(pendingWrite);
	pendingCluster.addChild(tool("after-pending-write", "print('verify pending')", true));
	const initialPendingLines = plain(pendingCluster.render(100)).split("\n");
	assert.ok(initialPendingLines.some((line) => line.includes("pending overwrite")), `write shows an opencode-style diff preview while it is running: ${JSON.stringify(initialPendingLines)}`);
	for (const previewLine of initialPendingLines.filter((line) => line.includes("pending overwrite") || line.includes("rendering diff"))) {
		assert.match(previewLine, /^ │\s+/, `the pending write rail must reach the next clustered call: ${JSON.stringify(previewLine)}`);
	}

	async function waitForPendingMode(width: number, mode: "split" | "unified"): Promise<string> {
		let rendered = "";
		for (let attempt = 0; attempt < 50; attempt++) {
			rendered = plain(pendingCluster.render(width));
			if (rendered.includes(`• ${mode}`)) return rendered;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		return rendered;
	}
	const narrowPending = await waitForPendingMode(100, "unified");
	assert.ok(narrowPending.includes("• unified"), `narrow pending writes use a unified diff: ${JSON.stringify(narrowPending)}`);
	const indentedBoundaryNarrow = await waitForPendingMode(140, "unified");
	assert.ok(indentedBoundaryNarrow.includes("• unified"), "auto mode subtracts tree, tool-shell, branch, and scrollbar chrome before its width check");
	const indentedBoundaryWide = await waitForPendingMode(141, "split");
	assert.ok(indentedBoundaryWide.includes("• split"), "auto mode switches only when the indented diff itself has 132 columns");
	const widePending = await waitForPendingMode(152, "split");
	assert.ok(widePending.includes("• split"), `wide pending writes use a split diff: ${JSON.stringify(widePending)}`);
	assert.ok(!/^\s*(old|new)\s*$/m.test(widePending), "split previews omit redundant old/new headings");

	// Width alone is not enough: auto mode must stay unified when either half
	// would wrap visible code, even though the configured split cutoff fits.
	const longWriteContent = readFileSync("config/config.example.json", "utf8").replace(
		'"diffViewMode": "auto"',
		`"diffViewMode": "auto-${"x".repeat(170)}"`,
	);
	const longWriteArgs = { path: "config/config.example.json", content: longWriteContent, activity: "implementing" };
	const longWrite = new ToolExecutionComponent("write", "long-line-write", longWriteArgs, {}, tools.get("write") as any, ui as any, process.cwd());
	longWrite.updateArgs(longWriteArgs);
	longWrite.setArgsComplete();
	longWrite.markExecutionStarted();
	longWrite.updateResult({ content: [{ type: "text", text: "" }], isError: false } as any, true);
	const longCluster = new Container();
	longCluster.addChild(longWrite);
	let longPreview = "";
	for (let attempt = 0; attempt < 50; attempt++) {
		longPreview = plain(longCluster.render(152));
		if (longPreview.includes("• unified")) break;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(longPreview.includes("• unified"), `auto mode avoids wrapped split columns: ${JSON.stringify(longPreview)}`);
	for (let attempt = 0; attempt < 50; attempt++) {
		longPreview = plain(longCluster.render(200));
		if (longPreview.includes("• split")) break;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(longPreview.includes("• split"), `full-width panes still use split mode for moderately long lines: ${JSON.stringify(longPreview)}`);

	// A resize must rebuild the width-keyed body rather than leaving ToolText's
	// one-frame reflow fallback as the permanent result.
	for (const [width, mode] of [[80, "unified"], [152, "split"]] as const) {
		let resized = "";
		for (let attempt = 0; attempt < 50; attempt++) {
			resized = plain(pendingCluster.render(width));
			if (resized.includes(`• ${mode}`) && resized.includes("previewLayout")) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.ok(resized.includes(`• ${mode}`) && resized.includes("previewLayout"), `resize to ${width} must finish reflowing the ${mode} diff: ${JSON.stringify(resized)}`);
	}

	// Anti-flicker: a diff that is already on screen must survive a rebuild. The placeholder
	// that stands in for a pending build is one or two lines tall, so replacing a rendered diff
	// with it collapses the row by dozens of lines and reflows the transcript under the reader —
	// which is what made scrolling jump onto whichever row was rebuilding.
	{
		const ruleCount = (lines: string[]) => lines.filter((line) => /─{10,}/.test(line)).length;
		const waitForRules = async (container: Container, width: number) => {
			let lines: string[] = [];
			for (let attempt = 0; attempt < 50; attempt++) {
				lines = plain(container.render(width)).split("\n");
				if (ruleCount(lines) >= 2) return lines;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			return lines;
		};
		const assertKeepsBody = (label: string, settled: string[], rebuilt: string[]) => {
			assert.ok(ruleCount(rebuilt) >= 2, `${label}: a rebuild must keep the rendered diff on screen: ${JSON.stringify(rebuilt)}`);
			assert.ok(rebuilt.length >= settled.length - 2, `${label}: a rebuild must not collapse the row (${settled.length} -> ${rebuilt.length} lines)`);
		};

		// 1. A running (pending) write whose width changes. Uses its own row: the shared fixture
		//    above must stay at its original width for the assertions that follow.
		const retentionWrite = new ToolExecutionComponent("write", "retention-pending-write", pendingWriteArgs, {}, tools.get("write") as any, ui as any, process.cwd());
		retentionWrite.updateArgs(pendingWriteArgs);
		retentionWrite.setArgsComplete();
		retentionWrite.markExecutionStarted();
		retentionWrite.updateResult({ content: [{ type: "text", text: "" }], isError: false } as any, true);
		const retentionCluster = new Container();
		retentionCluster.addChild(retentionWrite);
		let pendingSettled = await waitForRules(retentionCluster, 152);
		assert.ok(ruleCount(pendingSettled) >= 2, `pending write fixture renders a diff body: ${JSON.stringify(pendingSettled)}`);
		assertKeepsBody("pending write (resize)", pendingSettled, plain(retentionCluster.render(96)).split("\n"));
		// A content change rebuilds at the same width: no reflow frame is involved, so this
		// exercises the retention itself.
		pendingSettled = await waitForRules(retentionCluster, 96);
		const changedContent = pendingWriteContent.replace('"diffSplitMinWidth": 144', '"diffSplitMinWidth": 150');
		retentionWrite.updateArgs({ ...pendingWriteArgs, content: changedContent });
		assertKeepsBody("pending write (content change)", pendingSettled, plain(retentionCluster.render(96)).split("\n"));

		// 2. A settled write result (`_wdk`/`_wdt`) rebuilt at a new width.
		const parsed = {
			lines: [
				{ type: "ctx", oldNum: 1, newNum: 1, content: "alpha" },
				{ type: "del", oldNum: 2, newNum: null, content: "beta" },
				{ type: "add", oldNum: null, newNum: 2, content: "beta changed" },
				{ type: "ctx", oldNum: 3, newNum: 3, content: "gamma" },
			],
			added: 1,
			removed: 1,
			chars: 40,
		} as any;
		const writeArgs = { path: "src/retention.ts", content: "x\n", activity: "implementing" };
		const settledWrite = new ToolExecutionComponent("write", "retention-write", writeArgs, {}, tools.get("write") as any, ui as any, process.cwd());
		settledWrite.updateArgs(writeArgs);
		settledWrite.setArgsComplete();
		settledWrite.markExecutionStarted();
		settledWrite.updateResult({ content: [{ type: "text", text: "ok" }], isError: false, details: { _type: "diff", summary: "+1 -1", diff: parsed, language: "typescript" } } as any, false);
		const writeCluster = new Container();
		writeCluster.addChild(settledWrite);
		const writeSettled = await waitForRules(writeCluster, 120);
		assert.ok(ruleCount(writeSettled) >= 2, `write result fixture renders a diff body: ${JSON.stringify(writeSettled)}`);
		assertKeepsBody("write result (resize)", writeSettled, plain(writeCluster.render(90)).split("\n"));
		// Expanding rebuilds the row at the same width (the key carries `expanded`), so the
		// placeholder must not be what the first frame after the toggle shows.
		const writeExpandedSettled = await waitForRules(writeCluster, 90);
		settledWrite.setExpanded(true);
		assertKeepsBody("write result (expand)", writeExpandedSettled, plain(writeCluster.render(90)).split("\n"));

		// 3. A settled edit result (`_pk`/`_ptDisplay`) rebuilt at a new width. The fixture file is
		//    read-only here: the tool never executes, so no temporary files are created.
		const editTarget = "config/config.example.json";
		const editArgs = { path: editTarget, edits: [{ oldText: '"diffSplitMinWidth": 132', newText: '"diffSplitMinWidth": 144' }], activity: "implementing" };
		const settledEdit = new ToolExecutionComponent("edit", "retention-edit", editArgs, {}, tools.get("edit") as any, ui as any, process.cwd());
		settledEdit.updateArgs(editArgs);
		settledEdit.setArgsComplete();
		settledEdit.markExecutionStarted();
		settledEdit.updateResult({ content: [{ type: "text", text: "ok" }], isError: false, details: { _type: "editInfo", summary: "+1 -1", editLine: 20, hunks: 1, added: 1, removed: 1 } } as any, false);
		const editCluster = new Container();
		editCluster.addChild(settledEdit);
		const editSettled = await waitForRules(editCluster, 120);
		assert.ok(ruleCount(editSettled) >= 2, `edit result fixture renders a diff body: ${JSON.stringify(editSettled)}`);
		assertKeepsBody("edit result (resize)", editSettled, plain(editCluster.render(90)).split("\n"));
		const editExpandedSettled = await waitForRules(editCluster, 90);
		settledEdit.setExpanded(true);
		assertKeepsBody("edit result (expand)", editExpandedSettled, plain(editCluster.render(90)).split("\n"));
	}

	const alignedPending = plain(pendingCluster.render(152)).split("\n");
	const pendingCallLine = alignedPending.find((line) => line.includes("write config/config.example.json"));
	const pendingRailLine = alignedPending.find((line) => line.includes("pending overwrite"));
	assert.ok(pendingCallLine && pendingRailLine, "pending write fixture exposes its tool row and preview rail");
	assert.equal(pendingCallLine!.indexOf("write") - 2, pendingRailLine!.indexOf("├"), "mutation preview rail descends directly from the tool status mark");

	const coloredWidePending = pendingCluster.render(152);
	const hatchLine = coloredWidePending.find((line) => line.includes("╱"));
	const borderLine = coloredWidePending.find((line) => line.includes("─"));
	assert.ok(hatchLine && borderLine, "split fixture must contain both hatch and border chrome");
	const fgBefore = (line: string, glyph: string) => {
		const prefix = line.slice(0, line.indexOf(glyph));
		return prefix.match(/\x1b\[38;(?:2;\d+;\d+;\d+|5;\d+)m/g)?.at(-1);
	};
	assert.equal(fgBefore(hatchLine!, "╱"), fgBefore(borderLine!, "─"), "split hatching and border rules use the same gray");
	assert.match(fgBefore(hatchLine!, "╱") ?? "", /38;2;1(?:[0-9]{2}|[3-9][0-9]);/, "default hatch chrome is a light gray, not near-black");

	// The light-theme nested preview rail must use that same gray; the fixed
	// dark-theme branch fallback previously made this bar look black.
	initTheme("light", false);
	const lightArgs = { ...pendingWriteArgs, content: pendingWriteContent.replace('"previewOnly": true', '"previewOnly": false') };
	const lightWrite = new ToolExecutionComponent("write", "light-rail-write", lightArgs, {}, tools.get("write") as any, ui as any, process.cwd());
	lightWrite.updateArgs(lightArgs);
	lightWrite.setArgsComplete();
	lightWrite.markExecutionStarted();
	lightWrite.updateResult({ content: [{ type: "text", text: "" }], isError: false } as any, true);
	const lightCluster = new Container();
	lightCluster.addChild(lightWrite);
	let coloredLight: string[] = [];
	for (let attempt = 0; attempt < 50; attempt++) {
		coloredLight = lightCluster.render(152);
		if (plain(coloredLight).includes("pending overwrite") && coloredLight.some((line) => line.includes("─"))) break;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	const lightRailLine = coloredLight.find((line) => line.includes("pending overwrite"));
	const lightRuleLine = coloredLight.find((line) => line.includes("─"));
	assert.ok(lightRailLine && lightRuleLine, "light-theme fixture renders its preview rail and rule");
	assert.equal(fgBefore(lightRailLine!, "├"), fgBefore(lightRuleLine!, "─"), "light-theme preview rail and diff chrome use the same gray");
	initTheme("dark", false);

	for (const width of [20, 48, 80, 100, 140, 152, 80, 152]) {
		for (const line of pendingCluster.render(width)) {
			assert.ok(visibleWidth(line) <= width, `pending write overflow at ${width}: ${visibleWidth(line)}`);
		}
	}

	const editArgs = {
		path: "extensions/diff-mode.ts",
		activity: "implementing",
		edits: [
			{ oldText: 'export type DiffViewMode = "auto" | "split" | "unified";', newText: 'export type DiffViewMode = "auto-wide" | "split" | "unified";' },
			{ oldText: "const DEFAULT_SPLIT_MIN_WIDTH = 132;", newText: "const DEFAULT_SPLIT_MIN_WIDTH = 144;" },
			{ oldText: "export function getDiffSplitMinWidth(config: DiffModeConfig): number {", newText: "export function resolveDiffSplitMinWidth(config: DiffModeConfig): number {" },
			{ oldText: " * Use side-by-side columns only once the configured threshold fits; the renderer", newText: " * Prefer side-by-side columns only once the configured threshold fits; the renderer" },
		],
	};
	const editCluster = new Container();
	const pendingEdit = new ToolExecutionComponent("edit", "four-hunk-edit", editArgs, {}, tools.get("edit") as any, ui as any, process.cwd());
	pendingEdit.updateArgs(editArgs);
	pendingEdit.setArgsComplete();
	pendingEdit.markExecutionStarted();
	pendingEdit.updateResult({ content: [{ type: "text", text: "" }], isError: false } as any, true);
	editCluster.addChild(pendingEdit);
	editCluster.addChild(tool("after-four-hunk-edit", "print('verify hunks')", true));
	let fourHunkPreview = "";
	for (let attempt = 0; attempt < 80; attempt++) {
		fourHunkPreview = plain(editCluster.render(100));
		if (fourHunkPreview.includes("4 hunks")) break;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(fourHunkPreview.includes("4 hunks"), `all edit hunks must render instead of a summary: ${JSON.stringify(fourHunkPreview)}`);
	for (const changedText of ["auto-wide", "144", "resolveDiffSplitMinWidth", "Prefer side-by-side"]) {
		assert.ok(fourHunkPreview.includes(changedText), `the full four-hunk preview must include ${changedText}: ${JSON.stringify(fourHunkPreview)}`);
	}
	assert.ok(fourHunkPreview.includes("MIN_SPLIT_COLUMN_WIDTH"), "the projected edit diff includes unchanged context around its hunks");
	for (const line of fourHunkPreview.split("\n").filter((line) => /auto-wide|resolveDiffSplitMinWidth|Prefer side-by-side/.test(line))) {
		assert.match(line, /^ │\s+/, `the edit preview rail must reach the next clustered call: ${JSON.stringify(line)}`);
	}

	pendingEdit.updateResult({
		content: [{ type: "text", text: "Applied 4 edits" }],
		details: { _type: "multiEditInfo", editCount: 4, diffLineCount: 16, hunks: 4, totalAdded: 7, totalRemoved: 4 },
		isError: false,
	} as any, false);
	let completedFourHunkPreview = "";
	for (let attempt = 0; attempt < 80; attempt++) {
		completedFourHunkPreview = plain(editCluster.render(100));
		if (completedFourHunkPreview.includes("Prefer side-by-side")) break;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(completedFourHunkPreview.includes("Prefer side-by-side"), `settled multi-edits keep every diff block instead of collapsing to stats: ${JSON.stringify(completedFourHunkPreview)}`);
	assert.ok(!/Edit \d+\/\d+|^\s*(old|new)\s*$/m.test(completedFourHunkPreview), "diffs omit per-edit and old/new column headings");
	assert.equal(completedFourHunkPreview.split("\n").filter((line) => /─{10,}/.test(line)).length, 5, "four edit blocks use one shared horizontal rule between neighbors");
	assert.ok(!/\d[+-]\s*│/.test(completedFourHunkPreview), "line-number gutters omit redundant +/- markers");
}

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

// Pending lights belong to the call rows: they default to the circle-breathe cycle, with
// the braille spinner and the classic blinking dot available through /cc-tools pending. A
// group header keeps a steady ● — its label already animates (the shimmer sweep), so a
// second animation on the same line only competes with it.
{
	const realNow = Date.now;
	let fakeNow = 1_700_000_000_000;
	Date.now = () => fakeNow;
	const breathe = "●•· ·•";        // AGENT_BREATHE_GLYPHS
	const spinner = "⠃⠉⠘⠰⢠⣀⡄⠆";
	const ctx = { hasUI: true, ui: { theme, notify() {}, getToolsExpanded: () => false, setToolsExpanded() {} } };
	// A header light sits between the margin and the label; a call row's light sits between
	// the ├/╰ connector and the tool name.
	const glyphOf = (parent: Container) => {
		const line = plain(parent.render(100)).split("\n").find((l) => l.includes("implementing")) ?? "";
		return line[1] ?? "";
	};
	const rowGlyphOf = (parent: Container) => {
		const line = plain(parent.render(100)).split("\n").find((l) => l.includes("python")) ?? "";
		return line.trimStart().replace(/^[├╰│] /, "")[0] ?? "";
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
		const breathing = pendingTool("breathe-frame");
		// The header is a steady ● whether the call is running or settled: the shimmering label
		// carries the liveness, and the pending cycle lives on the row below.
		assert.equal(glyphOf(breathing.parent), "●", `a pending group header keeps a steady light: ${JSON.stringify(glyphOf(breathing.parent))}`);
		fakeNow += 500;
		assert.equal(glyphOf(breathing.parent), "●", "the header light must not advance with the clock");
		// Individual call rows keep the configured pending light, clock-driven like the spinner.
		const rowFirst = rowGlyphOf(breathing.parent);
		assert.ok(breathe.includes(rowFirst), `a pending call row breathes by default: ${JSON.stringify(rowFirst)}`);
		fakeNow += 500;
		assert.notEqual(rowGlyphOf(breathing.parent), rowFirst, "the row's breathe glyph must advance with the clock");
		// Settled groups show the static filled light (green ●), never a cycle frame.
		breathing.component.updateResult({ content: [{ type: "text", text: "ok" }], isError: false } as any, false);
		assert.equal(glyphOf(breathing.parent), "●", "a settled group shows the static status light");
		assert.equal(rowGlyphOf(breathing.parent), "✓", "a settled call row shows its ✓");

		const spinnerCase = pendingTool("spinner-frame");
		await commands.get("cc-tools").handler("pending spinner", ctx);
		assert.ok(spinner.includes(rowGlyphOf(spinnerCase.parent)), `spinner mode drives the call row: ${JSON.stringify(rowGlyphOf(spinnerCase.parent))}`);
		assert.equal(glyphOf(spinnerCase.parent), "●", "the header stays steady in spinner mode");
		const dotCase = pendingTool("dot-frame");
		await commands.get("cc-tools").handler("pending dot", ctx);
		assert.ok("● ".includes(rowGlyphOf(dotCase.parent)), `dot mode must blink the row, not cycle: ${JSON.stringify(rowGlyphOf(dotCase.parent))}`);
		await commands.get("cc-tools").handler("pending breathe", ctx);
		assert.ok(breathe.includes(rowGlyphOf(spinnerCase.parent)), "breathe mode comes back as the default");
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

// The repaint loop follows the chunk, not the calls in flight. A chunk whose calls have
// all settled but which the agent is still working on (thinking, composing the next call)
// has nothing else asking for frames — and that is exactly when the ticking total and the
// sweep need them. Closing the chunk releases the loop instead of leaving it running.
{
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	const agentEnd = async () => { for (const handler of handlers.get("agent_end") ?? []) await handler({}, {}); };
	const agentStart = async () => { for (const handler of handlers.get("agent_start") ?? []) await handler({}, {}); };
	const renders = { count: 0 };
	const loopParent = new Container();
	const settledTool = new ToolExecutionComponent(
		"code_execution", "loop-settled", { code: "print(1)", activity: "implementing" }, {}, definition as any,
		{ requestRender: () => { renders.count++; } } as any, process.cwd(),
	);
	settledTool.markExecutionStarted();
	settledTool.updateResult({ content: [{ type: "text", text: "ok" }], isError: false } as any, false);
	loopParent.addChild(settledTool);
	// A finished run must not leave a loop behind (this also releases the timer any earlier
	// block left armed).
	await agentEnd();
	loopParent.render(100);
	await agentStart();
	loopParent.render(100);
	const afterArming = renders.count;
	// No further render happens here: if the loop were still waiting for one, its total
	// would freeze on screen forever.
	await sleep(250);
	assert.ok(renders.count >= afterArming + 2, `a live chunk with every call settled must keep repainting itself: ${renders.count - afterArming} frames`);
	// Prose closes the chunk: the loop is released and nothing re-arms it.
	const prose = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "the answer" }] } as any;
	const answer = new AssistantMessageComponent(prose, false);
	answer.updateContent(prose, false);
	loopParent.addChild(answer);
	loopParent.render(100);
	await sleep(250); // Let anything already armed fire before taking the reading.
	const settledFrames = renders.count;
	await sleep(250);
	assert.equal(renders.count, settledFrames, "a closed chunk must release the repaint loop");
}

// A live chunk's total ticks off the wall clock, including the quiet stretches between
// calls, and freezes at whatever it reached once the chunk closes.
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
		// The call settles, but the agent has not moved on: the chunk is still live, so the
		// header keeps counting instead of freezing at the recorded sum.
		for (const handler of handlers.get("tool_execution_end") ?? []) {
			await handler({ toolCallId: callId, toolName: "code_execution", args: {} }, ui);
		}
		running.updateResult({ content: [{ type: "text", text: "done" }], isError: false } as any, false);
		assert.ok(/testing 1 call · 9s/.test(plain(liveParent.render(100))), "a settled call reports its recorded run");
		fakeNow += 30000;
		assert.ok(/testing 1 call · 39s/.test(plain(liveParent.render(100))), `a live chunk keeps ticking after its last call settles: ${JSON.stringify(plain(liveParent.render(100)).split("\n")[0])}`);
		// Prose after the group closes the chunk: the total freezes where it got to (it must
		// not fall back to the sum of the recorded spans and visibly shrink).
		const prose = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "writing the answer" }] } as any;
		const answer = new AssistantMessageComponent(prose, false);
		answer.updateContent(prose, false);
		liveParent.addChild(answer);
		const closed = plain(liveParent.render(100));
		assert.ok(/testing 1 call · 39s/.test(closed), `a closed chunk keeps the total it reached: ${JSON.stringify(closed.split("\n")[0])}`);
		fakeNow += 30000;
		assert.equal(closed, plain(liveParent.render(100)), "a closed chunk must stop ticking");
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

// The label shimmer belongs to the chunk, not to a single call: it sweeps while the
// chunk is the agent's live work — from the group's first call until prose follows it, a
// different activity label supersedes it, or the run ends — and individual calls settling
// does not stop it. The light stays the per-call indicator (settled calls never blink).
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
		// Colors that belong to the label itself: the one opening it plus any interleaved
		// between its characters (the dot/branch colors before it are not ours).
		// The gradient interleaves color codes between the label's characters, so the
		// label is not a contiguous substring of the raw line: strip first, then take
		// every color between the status glyph (spinner while running) and the counts.
		const labelColors = (lines: string[], text = "implementing") => {
			const line = lines.find((l) => l.replace(/\x1b\[[0-9;]*m/g, "").includes(text)) ?? "";
			const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
			const glyphAt = stripped.search(/[\u2800-\u28FF●•·]/);
			const callAt = line.indexOf("1 call");
			if (glyphAt < 0 || callAt < 0) return [];
			const region = line.slice(glyphAt + 1, callAt);
			return [...region.matchAll(/\x1b\[38;2;\d+;\d+;\d+m/g)].map((m) => m[0]);
		};
		const header = (lines: string[]) => plain(lines).split("\n")[0];
		// The band only covers part of the label at any instant, so a single arbitrary frame can
		// legitimately show the resting color alone. Sample a whole sweep at the live repaint
		// cadence: these assertions are about how the sweep behaves over time.
		const sampleSweep = (render: () => string[], text = "implementing", samples = 16): string[][] => {
			const frames: string[][] = [];
			for (let i = 0; i < samples; i++) {
				frames.push(labelColors(render(), text));
				fakeNow += 120;
			}
			return frames;
		};
		const distinct = (frames: string[][]) => new Set(frames.flat());
		const phases = (frames: string[][]) => new Set(frames.map((f) => f.join()).filter(Boolean)).size;

		const firstFrame = shimmerParent.render(100);
		assert.ok(/implementing/.test(plain(firstFrame)), "the label text survives the gradient");
		const running = sampleSweep(() => shimmerParent.render(100));
		assert.ok(distinct(running).size >= 3, `a running label must be a gradient, got ${distinct(running).size} colors`);
		assert.ok(phases(running) >= 2, "the running label must animate between frames");
		// The call settles. The light becomes the steady success dot — the chunk never
		// blinks a dot of its own — but the sweep keeps going: the agent still owns this
		// chunk (it is thinking, or composing the next call).
		pendingTool.updateResult({ content: [{ type: "text", text: "ok" }], isError: false } as any, false);
		const settledFrame = shimmerParent.render(100);
		assert.ok(/^ ● implementing 1 call/.test(header(settledFrame)), `a settled call keeps a steady light: ${JSON.stringify(header(settledFrame))}`);
		const settled = sampleSweep(() => shimmerParent.render(100));
		assert.ok(distinct(settled).size >= 3, `settling a call must not stop the chunk's sweep: ${JSON.stringify([...distinct(settled)])}`);
		assert.ok(phases(settled) >= 2, "the sweep keeps moving after the call settles");
		// pi prints status notices into the transcript while a run is in flight — the
		// `Thinking level: …` and `Switched to …` lines that Shift+Tab and Ctrl+P post. They are
		// chrome, not the conversation moving on, so they must not close the live chunk: closing
		// it froze the sweep and the duration mid-run.
		shimmerParent.addChild(new Spacer(1));
		shimmerParent.addChild(new Text("Thinking level: max", 1, 0));
		assert.ok(plain(shimmerParent.render(100)).includes("Thinking level: max"), "the notice still renders");
		const noticed = sampleSweep(() => shimmerParent.render(100));
		assert.ok(distinct(noticed).size >= 3, `a status notice must not stop the sweep: ${JSON.stringify([...distinct(noticed)])}`);
		assert.ok(phases(noticed) >= 2, "the sweep keeps moving past a notice");
		// A different activity label supersedes the chunk: the closed label is done, the
		// new trailing chunk takes over the sweep.
		const next = new ToolExecutionComponent("code_execution", "shimmer-next", { code: "print(2)", activity: "testing" }, {}, definition as any, ui as any, process.cwd());
		next.markExecutionStarted();
		next.updateResult({ content: [{ type: "text", text: "ok" }], isError: false } as any, true);
		shimmerParent.addChild(next);
		const superseded = sampleSweep(() => shimmerParent.render(100));
		assert.ok(distinct(superseded).size <= 1, `a superseded chunk must stop sweeping: ${JSON.stringify([...distinct(superseded)])}`);
		const superseding = sampleSweep(() => shimmerParent.render(100), "testing");
		assert.ok(distinct(superseding).size >= 3, `the label that superseded it is the live one: ${JSON.stringify([...distinct(superseding)])}`);
		// Prose after the group closes the trailing chunk as well.
		const prose = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "writing the answer" }] } as any;
		const answer = new AssistantMessageComponent(prose, false);
		answer.updateContent(prose, false);
		shimmerParent.addChild(answer);
		const closed = sampleSweep(() => shimmerParent.render(100), "testing");
		assert.ok(distinct(closed).size <= 1, `prose must close the chunk and stop the sweep: ${JSON.stringify([...distinct(closed)])}`);
		const closedFrame = shimmerParent.render(100);
		fakeNow += 250;
		assert.equal(closedFrame.join("\n"), shimmerParent.render(100).join("\n"), "a closed chunk must not animate");
	} finally {
		Date.now = realNow;
	}
}
// The sweep's color is the active theme's color for the *current thinking level*, so a live
// label is tinted by how hard the model is being asked to think. Pinned here: the level
// color is used as-is (no darkening), the resting label is plain theme text (no fade), a
// runtime level change repaints the running sweep, and a muted level stays visible.
{
	const realNow = Date.now;
	let fakeNow = 1_700_000_000_000;
	Date.now = () => fakeNow;
	try {
		// everforest-tui-light: text #5c6a72, toolSuccessBg #edf0df, and the thinking-level
		// colors (medium = aqua, max = orange, off = a surface tone that needs the guard).
		const fg: Record<string, string> = {
			text: "\x1b[38;2;92;106;114m",
			thinkingMedium: "\x1b[38;2;53;167;124m",
			thinkingMax: "\x1b[38;2;245;125;38m",
			thinkingOff: "\x1b[38;2;223;221;200m",
		};
		const bg: Record<string, string> = { toolSuccessBg: "\x1b[48;2;237;240;223m" };
		// Pi publishes the live theme on globalThis and several chrome paths re-derive from
		// that slot, so the fake has to own it for the length of this block. It borrows the
		// real theme's text/bold helpers so the tool component renders normally.
		const globalThemeKey = Symbol.for("@earendil-works/pi-coding-agent:theme");
		const previousGlobalTheme = (globalThis as any)[globalThemeKey];
		const fakeTheme = Object.assign(Object.create(previousGlobalTheme), {
			name: "everforest-tui-light",
			getFgAnsi: (key: string) => fg[key] ?? "\x1b[38;2;128;128;128m",
			getBgAnsi: (key: string) => bg[key] ?? "\x1b[48;2;0;0;0m",
		});
		(globalThis as any)[globalThemeKey] = fakeTheme;
		const themeCtx = {
			hasUI: true,
			thinkingLevel: "medium",
			ui: { theme: fakeTheme, notify() {}, getToolsExpanded: () => false, setToolsExpanded() {} },
		};
		try {
			for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "resume" }, themeCtx);
			// session_start clears the work window, and the grouping only counts a call as live
			// while one is open, so the render below needs both.
			for (const handler of handlers.get("agent_start") ?? []) await handler({}, themeCtx);

			const accentParent = new Container();
			const live = new ToolExecutionComponent("code_execution", "shimmer-accent", { code: "print(1)", activity: "implementing" }, {}, definition as any, ui as any, process.cwd());
			live.markExecutionStarted();
			live.updateResult({ content: [{ type: "text", text: "ok" }], isError: false } as any, true);
			accentParent.addChild(live);
			// Everything up to the counts is the header: the label's own gradient plus the light
			// in front of it (whose gray is nowhere near any expected color).
			const rawFrameColors = () => {
				const raw =
					accentParent
						.render(100)
						.find((line) => line.replace(/\x1b\[[0-9;]*m/g, "").includes("implementing")) ?? "";
				return [...raw.slice(0, raw.indexOf("1 call")).matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map((m) => [
					+m[1],
					+m[2],
					+m[3],
				]);
			};
			// Sample a whole sweep: the band only sits over the label for part of the cycle, so
			// the color under test has to come from the cycle's union rather than one frame.
			const frameColors = () => {
				const colors: number[][] = [];
				for (let i = 0; i < 16; i++) {
					colors.push(...rawFrameColors());
					fakeNow += 120;
				}
				return colors;
			};
			const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
			const nearest = (colors: number[][], target: number[]) => Math.min(...colors.map((c) => dist(c, target)));
			const chooseLevel = async (level: string) => {
				for (const handler of handlers.get("thinking_level_select") ?? []) await handler({ level }, themeCtx);
			};

			const medium = frameColors();
			assert.ok(medium.length >= 3, `the gradient must be present: ${JSON.stringify(medium)}`);
			assert.ok(nearest(medium, [92, 106, 114]) <= 4, `the resting label is the theme text, with no fade: ${JSON.stringify(medium)}`);
			assert.ok(nearest(medium, [53, 167, 124]) <= 12, `thinking=medium sweeps in thinkingMedium: ${JSON.stringify(medium)}`);

			// The level changes at runtime (/thinking, Shift+Tab, model switch): a sweep already on
			// screen has to pick the new color up on the next frame.
			await chooseLevel("max");
			const max = frameColors();
			assert.ok(nearest(max, [245, 125, 38]) <= 12, `thinking=max sweeps in thinkingMax: ${JSON.stringify(max)}`);
			assert.ok(nearest(max, [53, 167, 124]) > 40, `the previous level's color must be gone: ${JSON.stringify(max)}`);

			// "off" is a surface tone in most palettes: too close to the panel to see, so the sweep
			// steps away from it rather than vanishing.
			await chooseLevel("off");
			const off = frameColors();
			assert.ok(off.length >= 3, `the muted level still sweeps: ${JSON.stringify(off)}`);
			const offBand = off.reduce((a, b) => (dist(b, [92, 106, 114]) > dist(a, [92, 106, 114]) ? b : a));
			const lin = (v: number) => {
				const s = v / 255;
				return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
			};
			const lum = (c: number[]) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
			const [hi, lo] = [lum(offBand), lum([237, 240, 223])].sort((a, b) => b - a);
			assert.ok((hi + 0.05) / (lo + 0.05) >= 1.6, `a muted level still has to read against the panel: ${JSON.stringify(off)}`);
			// The band must also separate from the label's own color. A level color that lands
			// near the theme's text left the sweep indistinguishable from the resting label,
			// which is exactly what "the shimmer is on but I can't see it" looks like.
			for (const level of ["medium", "max", "off"]) {
				await chooseLevel(level);
				const colors = frameColors();
				const band = colors.reduce((a, b) => (dist(b, [92, 106, 114]) > dist(a, [92, 106, 114]) ? b : a));
				assert.ok(
					dist(band, [92, 106, 114]) >= 72,
					`thinking=${level} must sweep a band that separates from the label: ${JSON.stringify(colors)}`,
				);
			}
		} finally {
			(globalThis as any)[globalThemeKey] = previousGlobalTheme;
		}
	} finally {
		Date.now = realNow;
	}
}
// A model that streams thinking at thousands of characters per second must not make the
// thinking clock climb tens of seconds per second. The text-length fallback assumes 150
// chars/s, so any provider that streams without thinking start/end markers used to report
// 20s per real second — in the thinking row and, summed, in the group header.
{
	const realNow = Date.now;
	let fakeNow = 1_700_000_000_000;
	Date.now = () => fakeNow;
	try {
		const ctx = { hasUI: true, ui: { theme, notify() {}, getToolsExpanded: () => false, setToolsExpanded() {} } };
		for (const handler of handlers.get("agent_start") ?? []) await handler({}, ctx);

		const done = new ToolExecutionComponent("code_execution", "rate-done", { code: "print(1)", activity: "implementing" }, {}, definition as any, ui as any, process.cwd());
		done.markExecutionStarted();
		done.updateResult({ content: [{ type: "text", text: "ok" }], isError: false } as any, false);
		const rateParent = new Container();
		rateParent.addChild(done);

		// A live assistant message streaming ~3000 chars/s, with no thinking_start event.
		let text = "Let me reason about this. ";
		const message: any = {
			role: "assistant",
			content: [{ type: "thinking", thinking: text }],
			stopReason: "pending",
			_piClaudeStyleThinkingActive: true,
		};
		for (const handler of handlers.get("message_start") ?? []) await handler({ message }, ctx);
		const assistant = new AssistantMessageComponent(message, false);
		assistant.updateContent(message, true);
		rateParent.addChild(assistant);

		// A second live thinking row in the same chunk shares the same wall clock. Two rows
		// reporting one growing block must not be summed into a total that runs at 2x.
		let secondText = "Second message thinking. ";
		const secondMessage: any = {
			role: "assistant",
			content: [{ type: "thinking", thinking: secondText }],
			stopReason: "pending",
			_piClaudeStyleThinkingActive: true,
		};
		for (const handler of handlers.get("message_start") ?? []) await handler({ message: secondMessage }, ctx);
		const secondAssistant = new AssistantMessageComponent(secondMessage, false);
		secondAssistant.updateContent(secondMessage, true);
		rateParent.addChild(secondAssistant);

		const seconds = (line: string, prefix: RegExp) => {
			const m = line.match(prefix);
			return m ? Number(m[1]) : 0;
		};
		let worst = 0;
		for (let frame = 1; frame <= 20; frame++) {
			fakeNow += 100;
			text += "x".repeat(300);
			message.content[0].thinking = text;
			assistant.updateContent(message, true);
			secondText += "y".repeat(300);
			secondMessage.content[0].thinking = secondText;
			secondAssistant.updateContent(secondMessage, true);
			const lines = plain(rateParent.render(120)).split("\n");
			const row = lines.find((l) => /Thinking…|Thought for/.test(l)) ?? "";
			const header = lines.find((l) => /calls?/.test(l)) ?? "";
			const wallSeconds = (fakeNow - 1_700_000_000_000) / 1000;
			worst = Math.max(
				worst,
				seconds(row, /Thinking… (\d+)s/),
				seconds(header, /· (\d+)s/),
			);
			assert.ok(
				worst <= wallSeconds + 1,
				`streaming thinking must not report faster than the clock (wall ${wallSeconds}s, shown ${worst}s): ${JSON.stringify(row)} ${JSON.stringify(header)}`,
			);
		}
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

// ---------------------------------------------------------------------------
// Activity API: other extensions can ask what this session is doing right now
// and what it has done, without scraping the transcript or the renderer.
// ---------------------------------------------------------------------------
{
	const api = (globalThis as any)[Symbol.for("pi-tool-tree:api")];
	assert.ok(api, "the API must be published on globalThis");
	assert.equal(
		api,
		(globalThis as any)[Symbol.for("pi-tool-tree:activity-api")],
		"the legacy label-integration key must resolve to the same object",
	);
	for (const name of ["getActivity", "getStats", "subscribe"]) assert.equal(typeof api[name], "function", `${name} must be callable`);
	assert.equal(api.formatDuration(1500), "1s", "durations format like the transcript");
	assert.equal(api.formatDuration(65_000), "1m 05s");

	const realNow = Date.now;
	let now = 1_800_000_000_000;
	Date.now = () => now;
	const apiCtx = { hasUI: true, ui: { theme, notify() {}, getToolsExpanded: () => false, setToolsExpanded() {} } };
	const fire = async (name: string, event: any = {}, ctxArg: any = apiCtx) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctxArg);
	};
	const assistantStream = (type: string) => ({ message: { role: "assistant" }, assistantMessageEvent: { type } });
	try {
		// Counters survive a resume: replaying a branch seeds them (call counts, failures,
		// reasoning time, runs/turns) so stats cover the session, not just this process.
		const branch = [
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
			{
				type: "message",
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [
						{ type: "thinking", thinking: "weighing options" },
						{ type: "toolCall", id: "seeded-1", name: "bash", arguments: { command: "bun test", activity: "testing" } },
					],
					_piClaudeStyleThinkingDurationMs: 4000,
				},
			},
			{ type: "message", message: { role: "toolResult", toolCallId: "seeded-1", toolName: "bash", isError: true, content: [] } },
			{
				type: "message",
				message: {
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "toolCall", id: "seeded-2", name: "edit", arguments: { path: "a.ts", activity: "implementing" } }],
					_piClaudeStyleWorkedDurationMs: 9000,
					_piClaudeStyleWorkedTurns: 2,
				},
			},
		];
		await fire("session_start", { reason: "resume" }, { ...apiCtx, sessionManager: { getBranch: () => branch } });
		assert.equal(api.getActivity().phase, "idle", "a resume starts idle");
		let stats = api.getStats();
		assert.equal(stats.toolCalls, 2, "seeded call counts");
		assert.equal(stats.toolCallsFailed, 1, "seeded failure counts");
		assert.equal(stats.thinkingMs, 4000, "seeded reasoning time from the stamped blocks");
		assert.equal(stats.thinkingBlocks, 1);
		assert.equal(stats.runs, 1, "seeded completed runs");
		assert.equal(stats.turns, 2, "seeded turn count");
		assert.equal(stats.workedMs, 9000, "seeded work total");
		assert.deepEqual(stats.byTool.bash, { calls: 1, failed: 1, durationMs: 0 }, "call time is not recoverable from history");
		assert.deepEqual(stats.byLabel.testing, { calls: 1, durationMs: 0 });
		assert.deepEqual(Object.keys(stats.byTool).sort(), ["bash", "edit"]);

		// --- a live run -----------------------------------------------------
		const changes: any[] = [];
		const unsubscribe = api.subscribe((activity: any, change: any) => {
			changes.push({
				type: change.type,
				phase: activity.phase,
				label: activity.label,
				changeLabel: change.label,
				toolCallId: change.toolCallId,
				isError: change.isError,
				durationMs: change.durationMs,
				toolCalls: change.run?.toolCalls,
			});
		});
		await fire("before_agent_start");
		let activity = api.getActivity();
		assert.equal(activity.phase, "waiting", "a run that has produced nothing yet is waiting");
		assert.equal(activity.isWorking, true);
		assert.equal(activity.label, "working", "an unnamed phase falls back to the default label");
		assert.equal(activity.labelCalls, 0);
		assert.deepEqual(activity.calls, []);

		now += 500;
		await fire("turn_start");
		assert.equal(api.getActivity().run.turns, 1);
		// before_agent_start + agent_start both fire in a real run; the second must not
		// restart the run clock.
		now += 500;
		await fire("agent_start");
		assert.equal(api.getActivity().run.elapsedMs, 1000, "a repeated run start must not reset the clock");

		// Thinking streams.
		now += 1000;
		await fire("message_start", { message: { role: "assistant" } });
		await fire("message_update", assistantStream("thinking_start"));
		activity = api.getActivity();
		assert.equal(activity.phase, "thinking");
		assert.equal(activity.isThinking, true);
		assert.equal(activity.isRunningTool, false);
		now += 2000;
		activity = api.getActivity();
		assert.equal(activity.thinkingElapsedMs, 2000, "reasoning time is measured live");
		assert.equal(activity.run.thinkingMs, 2000, "and counts toward the run's reasoning total");
		// Some providers skip thinking_end; the next kind of stream output ends it. A
		// repeated thinking_start must not restart (and so lose) the block's clock.
		now += 1000;
		await fire("message_update", assistantStream("thinking_start"));
		assert.equal(api.getActivity().thinkingElapsedMs, 3000);
		await fire("message_update", assistantStream("text_start"));
		activity = api.getActivity();
		assert.equal(activity.isThinking, false, "text output ends an unterminated reasoning block");
		assert.equal(activity.phase, "responding");
		await fire("message_update", assistantStream("text_end"));
		assert.equal(api.getActivity().phase, "waiting");

		// A call starts: the phase, its label, and the running-call list all follow.
		now += 100;
		await fire("tool_execution_start", { toolCallId: "live-1", toolName: "bash", args: { command: "bun test", activity: "testing" } });
		activity = api.getActivity();
		assert.equal(activity.phase, "tool");
		assert.equal(activity.isRunningTool, true);
		assert.equal(activity.label, "testing", "the model's label names the current activity");
		assert.equal(activity.labelCalls, 1);
		assert.equal(activity.run.toolCalls, 1);
		assert.deepEqual(activity.calls.map((call: any) => [call.toolName, call.label]), [["bash", "testing"]]);
		now += 3000;
		activity = api.getActivity();
		assert.equal(activity.calls[0].elapsedMs, 3000, "a running call reports live elapsed time");
		assert.equal(activity.run.toolMs, 3000, "and counts toward the run's tool time while it runs");
		// Unlabeled calls (plugins, MCP) continue the label in effect instead of
		// starting a new phase, and parallel calls are all reported.
		now += 1000;
		await fire("tool_execution_start", { toolCallId: "live-2", toolName: "read", args: { path: "a.ts" } });
		activity = api.getActivity();
		assert.equal(activity.label, "testing");
		assert.equal(activity.labelCalls, 2);
		assert.equal(activity.calls.length, 2, "parallel calls are all listed");
		assert.equal(activity.run.toolMs, 4000, "parallel spans each contribute their own time");

		// Settling: a success and a failure, then a new label starts a new phase.
		now += 1000;
		await fire("tool_execution_end", { toolCallId: "live-1", toolName: "bash", isError: false });
		now += 1000;
		await fire("tool_execution_end", { toolCallId: "live-2", toolName: "read", isError: true });
		activity = api.getActivity();
		assert.equal(activity.calls.length, 0);
		assert.equal(activity.phase, "waiting", "no calls and no stream: waiting on the model");
		assert.equal(activity.run.toolCalls, 2);
		assert.equal(activity.run.toolCallsFailed, 1);
		assert.equal(activity.run.toolMs, 5000 + 2000, "settled calls keep the span they recorded");
		const settledStats = api.getStats();
		assert.equal(settledStats.toolCalls, 4, "settled calls land in the session totals");
		assert.equal(settledStats.byTool.read.failed, 1);
		assert.equal(settledStats.byLabel.testing.calls, 3, "seeded plus the two live calls under this label");

		now += 500;
		await fire("tool_execution_start", { toolCallId: "live-3", toolName: "edit", args: { path: "a.ts", activity: "implementing" } });
		activity = api.getActivity();
		assert.equal(activity.label, "implementing", "a new label supersedes the phase");
		assert.equal(activity.labelCalls, 1, "per-label call counts reset with the label");
		assert.equal(activity.labelElapsedMs, 0);
		now += 7000;
		activity = api.getActivity();
		assert.equal(activity.labelElapsedMs, 7000, "time spent on the current activity is wall clock");
		assert.equal(activity.run.toolCalls, 3);
		await fire("tool_execution_end", { toolCallId: "live-3", toolName: "edit", isError: false });

		// A final answer ends the run: session totals grow, the run resets.
		now += 1000;
		const workedBefore = api.getStats().workedMs;
		await fire("message_end", { message: { role: "assistant", content: [], stopReason: "stop" } });
		assert.ok(api.getStats().workedMs > workedBefore, "a finished run adds its work time");
		await fire("agent_end");
		activity = api.getActivity();
		assert.equal(activity.phase, "idle");
		assert.equal(activity.isWorking, false);
		assert.equal(activity.label, null, "an idle session has no current activity");
		assert.equal(activity.run.elapsedMs, 0);
		assert.equal(activity.run.toolCalls, 0, "run counters reset for the next run");
		stats = api.getStats();
		assert.equal(stats.toolCalls, 5, "session totals survive the run");
		assert.equal(stats.toolCallsFailed, 2);
		assert.equal(stats.thinkingMs, 4000 + 3000);
		assert.equal(stats.thinkingBlocks, 2);
		assert.equal(stats.runs, 2);
		assert.equal(stats.turns, 3, "turns accumulate across finished runs");
		assert.equal(stats.byLabel.implementing.calls, 2);

		// Change events, in order, with per-event detail.
		assert.deepEqual(
			changes.map((change) => change.type),
			[
				"run-start", "turn-start", "thinking-start", "thinking-end",
				"stream-start", "stream-end",
				"label-change", "tool-start", "tool-start", "tool-end", "tool-end",
				"label-change", "tool-start", "tool-end", "run-end",
			],
		);
		assert.deepEqual(
			changes.filter((change) => change.type === "label-change").map((change) => change.changeLabel),
			["testing", "implementing"],
			"a label change reports the label the model named",
		);
		assert.equal(changes.find((change) => change.type === "tool-end" && change.isError)?.toolCallId, "live-2");
		assert.equal(changes.find((change) => change.type === "thinking-end")?.durationMs, 3000);
		const runEnd = changes.find((change) => change.type === "run-end");
		assert.equal(runEnd.phase, "idle", "a run-end listener sees the session already idle");
		assert.equal(runEnd.toolCalls, 3, "and the finished run's own totals");
		unsubscribe();

		// Listener hygiene: a throwing listener must not break the agent, and an
		// unsubscribe must actually stop delivery.
		const seen: string[] = [];
		const stop = api.subscribe(() => { throw new Error("listener blew up"); });
		const stopGood = api.subscribe(() => { seen.push("ok"); });
		await fire("agent_start");
		assert.deepEqual(seen, ["ok"], "one bad listener must not stop the others");
		stop();
		stopGood();
		await fire("turn_start");
		assert.deepEqual(seen, ["ok"], "unsubscribed listeners stop receiving changes");
		await fire("agent_end");

		// Snapshots are copies: a consumer cannot corrupt tracked state.
		await fire("agent_start");
		await fire("tool_execution_start", { toolCallId: "live-4", toolName: "bash", args: { activity: "testing" } });
		const handed = api.getActivity();
		handed.calls.push({ toolCallId: "fake" } as any);
		handed.run.toolCalls = 999;
		const fresh = api.getActivity();
		assert.equal(fresh.calls.length, 1);
		assert.equal(fresh.run.toolCalls, 1);
		// A call that never ends before the run does is settled as a failure rather than
		// silently dropped from the totals.
		await fire("agent_end");
		assert.equal(api.getStats().byTool.bash.failed, 2, "the seeded failure plus the interrupted call");
		assert.equal(api.getActivity().phase, "idle");
		// Events that arrive without a run, or twice, must not corrupt the state.
		await fire("agent_end");
		await fire("tool_execution_end", { toolCallId: "never-started", toolName: "bash", isError: true });
		assert.equal(api.getStats().toolCalls, 7, "an unmatched end still counts as a settled call");
	} finally {
		Date.now = realNow;
	}
	console.log("OK  activity API: live phase, labels, running calls, session stats, subscriptions, seeding");
}

process.env.HOME = realHome;
const { execFileSync } = await import("node:child_process");
execFileSync("trash", [tmpHome]);
