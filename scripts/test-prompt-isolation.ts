import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Loader } from "@earendil-works/pi-tui";
import extension from "../extensions/index.ts";

// Capture another extension's user-message/loader implementation before loading.
const userRender = UserMessageComponent.prototype.render;
const loaderStart = Loader.prototype.start;
const loaderStop = Loader.prototype.stop;
const commands = new Map<string, any>();
const handlers = new Map<string, any[]>();
const tools = new Map<string, any>();
const pi = {
	registerTool(tool: any) { tools.set(tool.name, tool); },
	registerCommand(name: string, command: any) { commands.set(name, command); },
	registerShortcut() {},
	on(name: string, handler: any) {
		handlers.set(name, [...(handlers.get(name) ?? []), handler]);
	},
};
extension(pi as any);
assert.equal(UserMessageComponent.prototype.render, userRender);
assert.equal(Loader.prototype.start, loaderStart);
assert.equal(Loader.prototype.stop, loaderStop);
assert.equal(commands.has("cc-spinner"), false);
assert.equal(commands.has("cc-tools"), true);
assert.equal(commands.has("cc-theme"), true);

const sentinel = "\x1b[48;2;12;34;56m";
const bgColors = new Map([["userMessageBg", sentinel]]);
const theme = {
	bgColors,
	fg: (_key: string, text: string) => text,
	bg: (_key: string, text: string) => text,
	getFgAnsi: () => "\x1b[38;2;80;90;100m",
	getBgAnsi: (key: string) => bgColors.get(key) ?? "\x1b[49m",
};
const untouched = () => { throw new Error("Prompt/footer UI must not be overridden"); };
const ctx = {
	hasUI: true,
	ui: {
		theme,
		notify() {},
		setToolsExpanded() {},
		getToolsExpanded: () => false,
		setEditorComponent: untouched,
		setFooter: untouched,
		setWorkingMessage: untouched,
	},
};
for (const handler of handlers.get("session_start") ?? []) {
	await handler({ reason: "resume" }, ctx);
}
// Also exercise the deferred theme rebinds scheduled during resume.
await new Promise((resolve) => setTimeout(resolve, 160));
assert.equal(bgColors.get("userMessageBg"), sentinel);
assert.equal(UserMessageComponent.prototype.render, userRender);

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.deepEqual(manifest.pi.extensions, ["./extensions/index.ts"]);
console.log("OK: user renderer, background, loader, and prompt/footer hooks remain untouched");
