import assert from "node:assert/strict";
import test from "node:test";

import {
	canRenderSplitLayout,
	getDiffSplitMinWidth,
	normalizeDiffRenderWidth,
	resolveDiffPresentationMode,
} from "../extensions/diff-mode.ts";

test("auto uses split when wide and unified below the threshold", () => {
	assert.equal(resolveDiffPresentationMode({ diffViewMode: "auto", diffSplitMinWidth: 120 }, 119), "unified");
	assert.equal(resolveDiffPresentationMode({ diffViewMode: "auto", diffSplitMinWidth: 120 }, 120), "split");
});

test("auto defaults to a conservative 132-column split threshold", () => {
	assert.equal(getDiffSplitMinWidth({}), 132);
	assert.equal(resolveDiffPresentationMode({}, 131), "unified");
	assert.equal(resolveDiffPresentationMode({}, 132), "split");
});

test("forced modes remain width-safe", () => {
	assert.equal(canRenderSplitLayout(48), false);
	assert.equal(canRenderSplitLayout(49), true);
	assert.equal(resolveDiffPresentationMode({ diffViewMode: "split" }, 48), "unified");
	assert.equal(resolveDiffPresentationMode({ diffViewMode: "split" }, 49), "split");
	assert.equal(resolveDiffPresentationMode({ diffViewMode: "unified" }, 200), "unified");
});

test("width and threshold inputs are normalized", () => {
	assert.equal(normalizeDiffRenderWidth(Number.NaN), 0);
	assert.equal(normalizeDiffRenderWidth(120.9), 120);
	assert.equal(getDiffSplitMinWidth({ diffSplitMinWidth: -1 }), 132);
	assert.equal(getDiffSplitMinWidth({ diffSplitMinWidth: 132.8 }), 132);
});
