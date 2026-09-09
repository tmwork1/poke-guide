import { expect, test } from '@playwright/test';

test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

declare global {
  interface Window {
    __megaPreviewToggle__: {
      setup: () => void;
    };
  }
}

test('メガストーン所持時にプレビューだけメガシンカ前後を切り替えられる', async ({ page }) => {
  await page.goto('/e2e-test-harness');
  await page.setContent(`
    <input id="species-name" value="リザードン" />
    <input id="item" value="リザードナイトX" />
    <section class="pokemon-preview" aria-label="ポケモンプレビュー" data-species-name="リザードン" data-item-name="リザードナイトX" data-level="50" data-nature="" data-ivs="[31,31,31,31,31,31]" data-evs="[0,0,0,0,0,0]">
      <div class="pokemon-preview-main">
        <div class="pokemon-preview-left">
          <div class="pokemon-preview-details">
            <div class="pokemon-preview-species-line" id="pokemon-preview-species-trigger" role="button" tabindex="0" aria-haspopup="dialog" aria-label="ポケモンを選択">
              <div id="pokemon-preview-species-name">リザードン</div>
              <span class="pokemon-preview-type-icons" id="pokemon-preview-type-icons" aria-label="タイプ"></span>
            </div>
            <div id="pokemon-preview-ability">-</div>
          </div>
          <ol class="pokemon-preview-moves" aria-label="技">
            <li class="pokemon-preview-move-trigger" data-move-slot="1"><span class="pokemon-preview-move-type-bar" id="pokemon-preview-move-type-1" hidden></span><span id="pokemon-preview-move-1">-</span></li>
            <li class="pokemon-preview-move-trigger" data-move-slot="2"><span class="pokemon-preview-move-type-bar" id="pokemon-preview-move-type-2" hidden></span><span id="pokemon-preview-move-2">-</span></li>
            <li class="pokemon-preview-move-trigger" data-move-slot="3"><span class="pokemon-preview-move-type-bar" id="pokemon-preview-move-type-3" hidden></span><span id="pokemon-preview-move-3">-</span></li>
            <li class="pokemon-preview-move-trigger" data-move-slot="4"><span class="pokemon-preview-move-type-bar" id="pokemon-preview-move-type-4" hidden></span><span id="pokemon-preview-move-4">-</span></li>
          </ol>
        </div>
        <div class="pokemon-preview-identity">
          <button type="button" class="pokemon-preview-sprite-wrap" aria-label="ポケモンプレビュー">
            <img id="pokemon-preview-species-sprite" width="112" height="112" />
            <span id="pokemon-preview-species-sprite-fallback"></span>
          </button>
        </div>
        <div class="pokemon-preview-right">
          <div class="pokemon-preview-item pokemon-preview-icon-text" id="pokemon-preview-item-trigger" role="button" tabindex="0" aria-haspopup="dialog" aria-label="もちものを選択">
            <img id="pokemon-preview-item-image" alt="" class="pokemon-preview-item-image" />
            <span id="pokemon-preview-item">リザードナイトX</span>
          </div>
          <div class="pokemon-preview-stats-wrap" id="pokemon-preview-stats-trigger" role="button" tabindex="0" aria-haspopup="dialog" aria-label="ステータス調整を開く">
            <table class="pokemon-preview-stats" aria-label="実数値と努力値"><tbody>
              <tr><th>H</th><td id="pokemon-preview-stat-hp">-</td><td id="pokemon-preview-ev-hp">-</td></tr>
              <tr><th>A</th><td id="pokemon-preview-stat-atk">-</td><td id="pokemon-preview-ev-atk">-</td></tr>
              <tr><th>B</th><td id="pokemon-preview-stat-def">-</td><td id="pokemon-preview-ev-def">-</td></tr>
              <tr><th>C</th><td id="pokemon-preview-stat-spa">-</td><td id="pokemon-preview-ev-spa">-</td></tr>
              <tr><th>D</th><td id="pokemon-preview-stat-spd">-</td><td id="pokemon-preview-ev-spd">-</td></tr>
              <tr><th>S</th><td id="pokemon-preview-stat-spe">-</td><td id="pokemon-preview-ev-spe">-</td></tr>
            </tbody></table>
          </div>
        </div>
      </div>
    </section>
  `);
  await page.waitForFunction(() => typeof window.__megaPreviewToggle__ !== 'undefined');
  await page.evaluate(() => window.__megaPreviewToggle__.setup());

  // スプライトのボタンは常に表示されているので、toBeVisible()だけでは
  // 「メガストーンを持っているから切り替えられる」ことの検証にならない。
  // renderToggle()が付け外しするdisabledとaria-labelで、切替先が決まったことを確かめる。
  const toggle = page.locator('.pokemon-preview-sprite-wrap');
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-label', 'メガリザードンXのプレビューへ切り替え');
  await toggle.tap();
  await expect(page.locator('#pokemon-preview-species-name')).toHaveText('メガリザードンX');
  await toggle.tap();
  await expect(page.locator('#pokemon-preview-species-name')).toHaveText('リザードン');
});

test('メガストーンを持っていなければプレビューを切り替えられない', async ({ page }) => {
  await page.goto('/e2e-test-harness');
  // 切替可否の判定に使うのは種族名ともちもの名だけなので、上のテストの完全な
  // プレビュー構造は要らない(判定に効く要素だけを置く)。
  await page.setContent(`
    <input id="species-name" value="リザードン" />
    <input id="item" value="いのちのたま" />
    <section class="pokemon-preview" data-species-name="リザードン" data-item-name="いのちのたま">
      <div class="pokemon-preview-main">
        <div class="pokemon-preview-identity">
          <button type="button" class="pokemon-preview-sprite-wrap" aria-label="ポケモンプレビュー">
            <img id="pokemon-preview-species-sprite" width="112" height="112" />
            <span id="pokemon-preview-species-sprite-fallback"></span>
          </button>
        </div>
        <div class="pokemon-preview-right"><span id="pokemon-preview-item">いのちのたま</span></div>
      </div>
      <div id="pokemon-preview-species-name">リザードン</div>
    </section>
  `);
  await page.waitForFunction(() => typeof window.__megaPreviewToggle__ !== 'undefined');
  await page.evaluate(() => window.__megaPreviewToggle__.setup());

  const toggle = page.locator('.pokemon-preview-sprite-wrap');
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute('aria-label', 'ポケモンプレビュー');
  await expect(page.locator('#pokemon-preview-species-name')).toHaveText('リザードン');
});
