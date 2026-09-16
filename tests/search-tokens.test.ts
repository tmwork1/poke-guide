import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitSearchTokens } from "../src/lib/search-tokens.ts";

describe("splitSearchTokens", () => {
	it("accepts every shared AND-search separator and removes empty tokens", () => {
		assert.deepEqual(splitSearchTokens("  ピカチュウ　,，、・/／|｜ライチュウ  "), ["ピカチュウ", "ライチュウ"]);
	});
});
