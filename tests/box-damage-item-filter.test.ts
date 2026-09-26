import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
	BOX_DAMAGE_IGNORED_ITEMS,
	withoutIgnoredBoxDamageItem,
} from "../src/lib/box-id/damage-calc-helpers.ts";
import type { PokemonSpec } from "../src/lib/pyodide-engine.ts";

const baseSpec: PokemonSpec = { name: "ピカチュウ", itemName: "こだわりメガネ" };

test("ボックスのダメージ計算では対象外アイテムをspecから外す", () => {
	assert.deepEqual([...BOX_DAMAGE_IGNORED_ITEMS], ["きあいのタスキ", "ふうせん"]);

	for (const itemName of BOX_DAMAGE_IGNORED_ITEMS) {
		const input = { ...baseSpec, itemName };
		const result = withoutIgnoredBoxDamageItem(input);
		assert.equal(result.itemName, undefined);
		assert.equal(input.itemName, itemName, "表示・保存元になる入力specは変更しない");
	}
});

test("対象外でないアイテムはそのまま計算specへ渡す", () => {
	assert.equal(withoutIgnoredBoxDamageItem(baseSpec), baseSpec);
	assert.equal(withoutIgnoredBoxDamageItem({ name: "ピカチュウ" }).itemName, undefined);
});
