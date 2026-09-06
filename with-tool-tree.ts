import { treeRenderCall, treeRenderResult, type ToolTreeSpec } from "./render.ts";

/**
 * Wrap a tool definition so it renders as a pi-tool-tree row.
 *
 * Execution is untouched — only rendering is taken over. The tool's original
 * `renderCall`/`renderResult` (if any) remain available behind ctrl+o
 * (`expanded`) so you can still inspect rich output on demand.
 *
 * Usage in a plugin extension:
 *
 * ```ts
 * import { withToolTree } from "<path-to>/pi-tool-tree/index.ts";
 *
 * pi.registerTool(withToolTree({
 *   name: "my_tool",
 *   label: "My Tool",
 *   description: "...",
 *   parameters: Type.Object({ ... }),
 *   async execute(toolCallId, params, signal, onUpdate, ctx) { ... },
 *   renderCall(args, theme, context) { ... },   // optional, shown when expanded
 *   renderResult(result, options, theme, context) { ... }, // optional, ditto
 * }, {
 *   summarizeCall: (args) => `${args.query}`,           // optional
 *   summarizeResult: (r) => `${r.details.count} items`, // optional
 * }));
 * ```
 */
export interface WithToolTreeOptions {
	/** Custom one-line call summary. Return undefined to use the generic summary. */
	summarizeCall?: (args: any) => string | undefined;
	/** Custom result suffix (plain text, e.g. "3 items"). Return undefined for none. */
	summarizeResult?: (result: any, isError: boolean) => string | undefined;
	/** Keep the tool's original renderers available via ctrl+o (default true). */
	keepExpandedRendering?: boolean;
}

export function withToolTree<T extends Record<string, any>>(tool: T, options: WithToolTreeOptions = {}): T {
	const spec: ToolTreeSpec = {
		toolName: tool.name,
		summarizeCall: options.summarizeCall,
		summarizeResult: options.summarizeResult,
		originalRenderCall: options.keepExpandedRendering === false ? undefined : tool.renderCall,
		originalRenderResult: options.keepExpandedRendering === false ? undefined : tool.renderResult,
	};

	return {
		...tool,
		// Render our own lines without the default padded Box — this is what
		// keeps collapsed rows to exactly one terminal line each.
		renderShell: "self" as const,
		renderCall(args: any, theme: any, context: any) {
			return treeRenderCall(spec, args, theme, context);
		},
		renderResult(result: any, renderOptions: any, theme: any, context: any) {
			return treeRenderResult(spec, result, renderOptions, theme, context);
		},
	} as T;
}
