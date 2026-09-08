import { expect, perfScenario, test, timeAction } from "../lib/perf";

const MATCHUP_CARD_SELECTOR = ".damage-calc-matchup-card";
const DAMAGE_TABLE_SELECTOR = ".damage-calc-matchup-card__table";

test("ダメージ計算画面を初回表示する", async ({ page }, testInfo) => {
  await perfScenario(
    testInfo,
    {
      id: "damage-calc-load",
      label: "ダメージ計算画面を初回表示",
      category: "page-load",
      targetMs: 5000,
      note: "対面カードの初期描画とPyodideによるダメージ表の初回計算を含む",
    },
    () =>
      timeAction(async () => {
        await page.goto("/damage-calc", { waitUntil: "load" });
        await page.locator(MATCHUP_CARD_SELECTOR).waitFor({ state: "visible" });
        await page.locator(DAMAGE_TABLE_SELECTOR).first().waitFor({ state: "visible" });
      }),
  );
});

test("ダメージ計算のコントロールパネルを開く", async ({ page }, testInfo) => {
  await page.goto("/damage-calc", { waitUntil: "load" });
  await page.locator(MATCHUP_CARD_SELECTOR).waitFor({ state: "visible" });

  const toggle = page.locator("#damage-calc-control-panel-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await perfScenario(
    testInfo,
    {
      id: "damage-calc-control-panel-open",
      label: "ダメージ計算のコントロールパネルを開く",
      category: "interaction",
      targetMs: 300,
      note: "表示状態のみを切り替え、計算条件や保存データは変更しない",
    },
    () =>
      timeAction(async () => {
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
      }),
  );
});
