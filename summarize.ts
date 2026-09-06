import { homedir } from "node:os";

/** Replace $HOME with ~ for display. */
export function shortenPath(p: unknown): string {
	if (typeof p !== "string" || p === "") return "";
	const home = homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** Collapse a string to a single line. */
export function oneLine(s: unknown): string {
	if (typeof s !== "string") return "";
	return s.replace(/\s*\n\s*/g, " ").trim();
}

export function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return max > 1 ? s.slice(0, max - 1) + "…" : s.slice(0, max);
}

/** Compact human-readable elapsed time for thinking and tool rows. */
export function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0.1, milliseconds / 1000);
	if (seconds < 10) return `${seconds.toFixed(1)}s`;
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = Math.round(seconds % 60);
	return `${minutes}m ${remainder}s`;
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
	if (!result?.content) return "";
	return result.content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text as string)
		.join("\n");
}

function countLines(text: string): number {
	const t = text.trim();
	return t === "" ? 0 : t.split("\n").length;
}

/**
 * One-line summary of a tool call's arguments (plain text, no colors).
 * Unknown tools fall back to a compact JSON dump.
 */
export function summarizeCall(toolName: string, args: any): string {
	const a = args ?? {};
	switch (toolName) {
		case "read": {
			let s = shortenPath(a.path);
			if (a.offset !== undefined || a.limit !== undefined) {
				const start = a.offset ?? 1;
				const end = a.limit !== undefined ? start + a.limit - 1 : "";
				s += `:${start}${end ? `-${end}` : ""}`;
			}
			return s;
		}
		case "bash":
		case "powershell":
			return oneLine(a.command);
		case "edit":
		case "write":
			return shortenPath(a.path);
		case "grep": {
			const target = shortenPath(a.path || ".");
			const glob = a.glob ? ` (${a.glob})` : "";
			return `/${oneLine(a.pattern)}/ in ${target}${glob}`;
		}
		case "find":
			return `${oneLine(a.pattern)} in ${shortenPath(a.path || ".")}`;
		case "ls":
			return shortenPath(a.path || ".");
		default: {
			try {
				return truncate(oneLine(JSON.stringify(a)), 80);
			} catch {
				return "";
			}
		}
	}
}

/**
 * Short result suffix, e.g. "14 matches" or "exit 1".
 * Returns undefined when there is nothing worth showing.
 */
export function summarizeResult(
	toolName: string,
	result: { content?: Array<{ type: string; text?: string }>; details?: any },
	isError: boolean,
): string | undefined {
	const text = textOf(result ?? {});
	switch (toolName) {
		case "bash":
		case "powershell": {
			if (!isError) return undefined;
			if (/cancel/i.test(text)) return "cancelled";
			const code = result?.details?.exitCode;
			return `exit ${code ?? "?"}`;
		}
		case "grep": {
			const n = countLines(text);
			return n > 0 ? `${n} matches` : undefined;
		}
		case "find": {
			const n = countLines(text);
			return n > 0 ? `${n} files` : undefined;
		}
		case "ls": {
			const n = countLines(text);
			return n > 0 ? `${n} entries` : undefined;
		}
		default:
			return undefined;
	}
}
