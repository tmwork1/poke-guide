import { expect, test } from '@playwright/test';

test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

test('メガストーン所持時にプレビューだけメガシンカ前後を切り替えられる', async ({ page }) => {
  await page.goto('/e2e-test-harness');
  await page.setContent(`
    <input id="species-name" value="リザードン" />
    <input id="item" value="リザードナイトX" />
    <section class="pokemon-preview" data-species-name="リザードン">
      <div class="pokemon-preview-main">
        <div class="pokemon-preview-left"><span id="pokemon-preview-species-name">リザードン</span></div>
        <div class="pokemon-preview-identity">
        <div class="pokemon-preview-sprite-wrap">
          <img id="pokemon-preview-species-sprite" />
          <span id="pokemon-preview-species-sprite-fallback"></span>
        </div>
        </div>
        <div class="pokemon-preview-right"><span id="pokemon-preview-item">リザードナイトX</span></div>
        <span class="pokemon-preview-type-icons"></span>
      </div>
    </section>
  `);
  await page.evaluate(async () => {
    const { setupMegaPreviewToggle } = await import('/src/lib/box-id/mega-preview-toggle.ts');
    setupMegaPreviewToggle();
  });

  const toggle = page.locator('.pokemon-preview-mega-toggle');
  await expect(toggle).toBeVisible();
  await toggle.tap();
  await expect(page.locator('#pokemon-preview-species-name')).toHaveText('メガリザードンX');
  await toggle.tap();
  await expect(page.locator('#pokemon-preview-species-name')).toHaveText('リザードン');
});
