import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { nextNatureBoosts } from "../src/lib/nature-toggle.ts";

describe("nextNatureBoosts", () => {
	it("無補正の最初のタップで、上昇・下降を同時に確定する", () => {
		assert.deepEqual(nextNatureBoosts({ up: null, down: null }, "atk"), {
			up: "atk", down: "spa", nextNeutralAssignment: "down",
		});
		assert.deepEqual(nextNatureBoosts({ up: null, down: null }, "spa"), {
			up: "spa", down: "atk", nextNeutralAssignment: "down",
		});
	});

	it("確定済み性格の未選択能力は下降・上昇を交互に入れ替える", () => {
		const first = nextNatureBoosts({ up: "atk", down: "spa" }, "def", "down");
		assert.deepEqual(first, { up: "atk", down: "def", nextNeutralAssignment: "up" });
		const second = nextNatureBoosts(first, "spd", first.nextNeutralAssignment);
		assert.deepEqual(second, { up: "spd", down: "def", nextNeutralAssignment: "down" });
		const third = nextNatureBoosts(second, "spe", second.nextNeutralAssignment);
		assert.deepEqual(third, { up: "spd", down: "spe", nextNeutralAssignment: "up" });
	});

	it("選択済み能力の再タップは完全に無補正へ戻す", () => {
		assert.deepEqual(nextNatureBoosts({ up: "atk", down: "spa" }, "atk"), {
			up: null, down: null, nextNeutralAssignment: "up",
		});
		assert.deepEqual(nextNatureBoosts({ up: "atk", down: "spa" }, "spa"), {
			up: null, down: null, nextNeutralAssignment: "up",
		});
	});
});
