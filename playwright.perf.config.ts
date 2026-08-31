import { defineConfig, devices } from "@playwright/test";

/**
 * パフォーマンス計測専用のPlaywright設定。`tests/e2e`(機能回帰)とは目的が異なるため
 * playwright.config.ts とは分離している。
 *
 * `npm run dev` (astro dev) を対象にする: 本番ビルド(astro preview)は
 * `build:master-data` を含め起動コストが高く、素早く繰り返し計測する用途に向かない。
 * dev serverは最適化なしのぶん絶対値は本番より遅くなるが、同一条件で毎回計測する分には
 * 回帰追跡(改善前後の相対比較)として十分機能する。本番相当の絶対値が必要になったら
 * 別途 astro preview 向けの設定を追加する。
 */
export default defineConfig({
  testDir: "./tests/perf/scenarios",
  testMatch: /.*\.perf\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // 1シナリオを複数回計測し、レポーター側で中央値を取ってブレを抑える。
  repeatEach: 3,
  timeout: 120_000,
  reporter: [["list"], ["./tests/perf/lib/perf-reporter.ts"]],
  use: {
    baseURL: "http://localhost:4321",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev -- --port 4321",
    url: "http://localhost:4321",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
