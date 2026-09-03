import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildDamageCalcCalculations, formatDamageCalcResult } from "../src/lib/damage-calc-page/spec-builder.ts";
import type { DamageCalcBuildInput } from "../src/lib/damage-calc-page/spec-builder.ts";
import type { CalcLethalSequenceResult } from "../src/lib/pyodide-engine.ts";

const base: Omit<DamageCalcBuildInput, "direction" | "moves"> = {
  selfSpec: { name: "ピカチュウ", level: 50, nature: "おくびょう", evs: [0, 0, 0, 32, 0, 32], ivs: [31, 31, 31, 31, 31, 31], teraType: "でんき" },
  opponentBuild: { speciesName: "カイリュー", abilityName: "マルチスケイル", itemName: "", teraType: "ノーマル", moveNames: ["しんそく"] },
  selfState: { boosts: [0, 1, 0, 0, 0, 0], ailment: "やけど", terastallized: true },
  opponentState: { boosts: [0, 0, 2, 0, 0, 0], ailment: "", terastallized: true },
  fieldState: { weather: "はれ", terrain: "エレキフィールド", selfSideFields: ["リフレクター"], opponentSideFields: ["ひかりのかべ"] },
};

describe("damage-calc spec-builder", () => {
  it("物理の攻撃欄では相手Bだけを3パターンにする", () => {
    const result = buildDamageCalcCalculations({ ...base, direction: "attack", moves: [{ moveName: "10まんボルト", category: "physical" }] });
    assert.deepEqual(result.calculations.map((c) => c.defenderSpec.evs), [[0, 0, 0, 0, 0, 0], [0, 0, 32, 0, 0, 0], [0, 0, 32, 0, 0, 0]]);
    assert.deepEqual(result.calculations.map((c) => c.defenderSpec.nature), ["まじめ", "まじめ", "ずぶとい"]);
    assert.deepEqual(result.calculations[0].attackerSpec.evs, base.selfSpec.evs);
  });

  it("特殊の攻撃欄では相手Dを3パターンにする", () => {
    const result = buildDamageCalcCalculations({ ...base, direction: "attack", moves: [{ moveName: "10まんボルト", category: "special" }] });
    assert.deepEqual(result.calculations.map((c) => c.defenderSpec.evs), [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 32, 0], [0, 0, 0, 0, 32, 0]]);
    assert.equal(result.calculations[2].defenderSpec.nature, "おだやか");
  });

  it("変化技は計算対象外にする", () => {
    const result = buildDamageCalcCalculations({ ...base, direction: "attack", moves: [{ moveName: "でんじは", category: "status" }] });
    assert.equal(result.calculations.length, 0);
    assert.deepEqual(result.skipped, [{ kind: "status", moveName: "でんじは" }]);
  });

  it("防御欄では相手がattacker、自分がdefenderになり自分側の壁を使う", () => {
    const result = buildDamageCalcCalculations({ ...base, direction: "defense", moves: [{ moveName: "しんそく", category: "physical" }] });
    assert.equal(result.calculations[0].attackerSpec.name, "カイリュー");
    assert.equal(result.calculations[0].defenderSpec.name, "ピカチュウ");
    assert.deepEqual(result.calculations[0].field.defenderSideFields, ["リフレクター"]);
    assert.deepEqual(result.calculations[0].attackerSpec.boosts, base.opponentState.boosts);
    assert.deepEqual(result.calculations[0].defenderSpec.boosts, base.selfState.boosts);
  });

  it("防御欄の物理/特殊では相手A/Cをそれぞれ3パターンにする", () => {
    const physical = buildDamageCalcCalculations({ ...base, direction: "defense", moves: [{ moveName: "しんそく", category: "physical" }] });
    const special = buildDamageCalcCalculations({ ...base, direction: "defense", moves: [{ moveName: "りゅうせいぐん", category: "special" }] });
    assert.deepEqual(physical.calculations.map((c) => c.attackerSpec.evs), [[0, 0, 0, 0, 0, 0], [0, 32, 0, 0, 0, 0], [0, 32, 0, 0, 0, 0]]);
    assert.deepEqual(special.calculations.map((c) => c.attackerSpec.evs), [[0, 0, 0, 0, 0, 0], [0, 0, 0, 32, 0, 0], [0, 0, 0, 32, 0, 0]]);
    assert.equal(physical.calculations[2].attackerSpec.nature, "いじっぱり");
    assert.equal(special.calculations[2].attackerSpec.nature, "ひかえめ");
  });

  it("calc_lethal非対応のはきだすは計算不可として分離する", () => {
    const result = buildDamageCalcCalculations({ ...base, direction: "attack", moves: [{ moveName: "はきだす", category: "special" }] });
    assert.equal(result.calculations.length, 0);
    assert.deepEqual(result.skipped, [{ kind: "unsupported", moveName: "はきだす" }]);
  });

  it("formatDamageCalcResultはバッチ内のmoveIndexごとに独立した%と確定数を返す", () => {
    // 2技をまとめた calcLethalSequence の結果を模す。1件目は確定1発(probability=1)、
    // 2件目は乱数2発45%。moveIndexを取り違えると1件目の値が両方に出てしまう。
    const result: CalcLethalSequenceResult = {
      defenderHp: 100,
      lethal: [{ attackCount: 1, probability: 1 }],
      perAttackDamages: [[60, 70], [20, 25]],
      perAttackLethal: [
        [{ attackCount: 1, probability: 1 }],
        [{ attackCount: 1, probability: 0 }, { attackCount: 2, probability: 0.45 }],
      ],
      cumulativeDamage: null,
    };
    assert.deepEqual(formatDamageCalcResult(result, 0), { damage: "60.0〜70.0%", verdict: "確1" });
    assert.deepEqual(formatDamageCalcResult(result, 1), { damage: "20.0〜25.0%", verdict: "乱2 (45.00%)" });
  });

  it("formatDamageCalcResultは全乱数分岐で倒れない場合に「-」を返す", () => {
    const result: CalcLethalSequenceResult = {
      defenderHp: 100,
      lethal: [],
      perAttackDamages: [[5, 8]],
      perAttackLethal: [[{ attackCount: 1, probability: 0 }]],
      cumulativeDamage: null,
    };
    assert.equal(formatDamageCalcResult(result, 0).verdict, "-");
  });
});
