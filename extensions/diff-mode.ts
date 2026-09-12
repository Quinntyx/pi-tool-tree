export type DiffViewMode = "auto" | "split" | "unified";

export interface DiffModeConfig {
	diffViewMode?: DiffViewMode;
	diffSplitMinWidth?: number;
}

export type DiffPresentationMode = "split" | "unified";

const DEFAULT_SPLIT_MIN_WIDTH = 132;
const MIN_SPLIT_COLUMN_WIDTH = 24;
const SPLIT_SEPARATOR_WIDTH = 1;

export function normalizeDiffRenderWidth(width: number): number {
	if (!Number.isFinite(width)) return 0;
	return Math.max(0, Math.floor(width));
}

export function getDiffSplitMinWidth(config: DiffModeConfig): number {
	const value = config.diffSplitMinWidth;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: DEFAULT_SPLIT_MIN_WIDTH;
}

export function canRenderSplitLayout(width: number): boolean {
	return normalizeDiffRenderWidth(width) >= MIN_SPLIT_COLUMN_WIDTH * 2 + SPLIT_SEPARATOR_WIDTH;
}

/**
 * Use side-by-side columns only once the configured threshold fits; the renderer
 * can still choose unified mode when either split column would wrap visible code.
 * A forced split only falls back when two usable columns physically cannot fit.
 */
export function resolveDiffPresentationMode(config: DiffModeConfig, width: number): DiffPresentationMode {
	const safeWidth = normalizeDiffRenderWidth(width);
	const canSplit = canRenderSplitLayout(safeWidth);
	if (config.diffViewMode === "unified") return "unified";
	if (config.diffViewMode === "split") return canSplit ? "split" : "unified";
	return safeWidth >= getDiffSplitMinWidth(config) && canSplit ? "split" : "unified";
}
