/**
 * UI改善ラウンド22 22-E-1: `calcStats()` / `calcLethalSequence()` のネイティブ一致確認。
 *
 * `tests/e2e/damage-calc.spec.ts` は `calcDamages()` のみをネイティブjpoke実行結果
 * (`expected.json`) と比較していたが、`/box/[id].astro` が実際に使う
 * `calcStats()` / `calcLethalSequence()` はこの比較の対象外だった
 * (`.claude/skills/jpoke/references/integration.md` §6、round-12.mdの指摘)。
 * このファイルは同じ枠組み(実ブラウザ上のPyodide実行 vs
 * `tests/e2e/fixtures/generate_expected.py` が生成したネイティブ実行の期待値)で
 * この2つの関数もカバーする。
 *
 * `calcLethalSequence()` はアプリ側(TypeScript)で複数の `Battle` を独立に構築し、
 * `LethalHitResult.__add__` でHP分布を自前合成する実装になっている
 * (`pyodide-engine.ts` の `calc_lethal_sequence_json` 内コメント参照)。ネイティブ実行との
 * 一致確認は、この自前合成ロジックがjpoke本体の挙動と食い違っていないかを検出できる
 * 数少ない手段のため、特に重要。
 */
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  PokemonSpec,
  FieldSpec,
  SequenceAttack,
  Stats,
  CalcLethalSequenceResult,
} from "../../src/lib/pyodide-engine";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures");

interface StatsFixtureCase {
  id: string;
  description: string;
  spec: PokemonSpec;
}

interface LethalSequenceFixtureCase {
  id: string;
  description: string;
  attacker: PokemonSpec;
  defender: PokemonSpec;
  attacks: SequenceAttack[];
  seed?: number;
  critical?: boolean;
  field?: FieldSpec;
}

const statsCases: StatsFixtureCase[] = JSON.parse(
  readFileSync(path.join(fixturesDir, "stats-cases.json"), "utf-8"),
);
const expectedStats: Record<string, { stats: Stats }> = JSON.parse(
  readFileSync(path.join(fixturesDir, "expected-stats.json"), "utf-8"),
);

const lethalSequenceCases: LethalSequenceFixtureCase[] = JSON.parse(
  readFileSync(path.join(fixturesDir, "lethal-sequence-cases.json"), "utf-8"),
);
const expectedLethalSequence: Record<string, CalcLethalSequenceResult> = JSON.parse(
  readFileSync(path.join(fixturesDir, "expected-lethal-sequence.json"), "utf-8"),
);

declare global {
  interface Window {
    __pyodideEngine__: {
      init: () => Promise<{ status: string; message: string }>;
      calcStats: (spec: PokemonSpec) => Promise<{ stats: Stats }>;
      calcLethalSequence: (
        attacker: PokemonSpec,
        defender: PokemonSpec,
        attacks: SequenceAttack[],
        options?: { seed?: number; critical?: boolean; field?: FieldSpec },
      ) => Promise<CalcLethalSequenceResult>;
      isReady: () => boolean;
    };
  }
}

async function initHarness(page: Page): Promise<void> {
  await page.goto("/e2e-test-harness");
  await page.waitForFunction(() => typeof window.__pyodideEngine__ !== "undefined");
  // Pyodideランタイム + jpoke wheel のロードは重い(初回は十数秒かかることがある)ため、
  // このawait自体はPlaywrightのデフォルトタイムアウトを持たない(呼び出し側のテストの
  // test.setTimeout()で全体の上限を確保する。tests/e2e/damage-calc.spec.tsと同じ方針)。
  await page.evaluate(() => window.__pyodideEngine__.init());
}

test.describe("実数値(calcStats)・加算ダメージ計算(calcLethalSequence): ブラウザ(Pyodide) vs jpokeネイティブ実行の等価性", () => {
  test.beforeAll(() => {
    expect(statsCases.length).toBeGreaterThan(0);
    for (const c of statsCases) {
      expect(expectedStats[c.id], `expected-stats.json に ${c.id} の期待値がありません。generate_expected.py を実行してください。`).toBeDefined();
    }
    expect(lethalSequenceCases.length).toBeGreaterThan(0);
    for (const c of lethalSequenceCases) {
      expect(expectedLethalSequence[c.id], `expected-lethal-sequence.json に ${c.id} の期待値がありません。generate_expected.py を実行してください。`).toBeDefined();
    }
  });

  test("calcStats(): 代表パターン全件がネイティブjpoke実行結果と完全一致する", async ({ page }) => {
    test.setTimeout(180_000);
    await initHarness(page);

    for (const testCase of statsCases) {
      await test.step(`${testCase.id}: ${testCase.description}`, async () => {
        const result = await page.evaluate(
          (spec) => window.__pyodideEngine__.calcStats(spec),
          testCase.spec,
        );
        expect(result.stats, `${testCase.id}: statsがネイティブ実行結果と不一致`).toEqual(
          expectedStats[testCase.id].stats,
        );
      });
    }
  });

  test("calcLethalSequence(): 代表パターン全件がネイティブjpoke実行結果と完全一致する", async ({ page }) => {
    test.setTimeout(180_000);
    await initHarness(page);

    for (const testCase of lethalSequenceCases) {
      await test.step(`${testCase.id}: ${testCase.description}`, async () => {
        const options = {
          seed: testCase.seed,
          critical: testCase.critical,
          field: testCase.field,
        };
        const result = await page.evaluate(
          ({ attacker, defender, attacks, options }) =>
            window.__pyodideEngine__.calcLethalSequence(attacker, defender, attacks, options),
          { attacker: testCase.attacker, defender: testCase.defender, attacks: testCase.attacks, options },
        );
        const expected = expectedLethalSequence[testCase.id];
        expect(result.lethal, `${testCase.id}: lethalがネイティブ実行結果と不一致`).toEqual(expected.lethal);
        expect(result.perAttackDamages, `${testCase.id}: perAttackDamagesがネイティブ実行結果と不一致`).toEqual(
          expected.perAttackDamages,
        );
        expect(result.perAttackLethal, `${testCase.id}: perAttackLethalがネイティブ実行結果と不一致`).toEqual(
          expected.perAttackLethal,
        );
        expect(result.cumulativeDamage, `${testCase.id}: cumulativeDamageがネイティブ実行結果と不一致`).toEqual(
          expected.cumulativeDamage,
        );
      });
    }
  });
});
