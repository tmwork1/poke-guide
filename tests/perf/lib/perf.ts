/**
 * パフォーマンス計測シナリオ共通ヘルパー。
 *
 * `tests/perf/scenarios/*.perf.spec.ts` はこのモジュールの `perfScenario` /
 * `timeNav` / `timeAction` だけを使ってシナリオを書く。計測結果は
 * `testInfo.annotations` に type: "perf" として積み、実体の集計・
 * dashboard.md への書き出しは `perf-reporter.ts` (playwright.perf.config.ts の
 * reporter) が一括で行う。シナリオ側はファイルI/Oを意識しなくてよい。
 */
import { test, expect, type Page, type TestInfo } from "@playwright/test";

export { test, expect };

/** 目標タイムの分類。docs/perf/dashboard.md の「分類」列に対応する。 */
export type PerfCategory = "page-load" | "interaction" | "close";

export interface PerfMeta {
  /** ダッシュボード上でシナリオを一意に特定するID。ファイル名+動作で命名する(例: "box-index-load")。 */
  id: string;
  /** ダッシュボードに表示する画面/操作名。 */
  label: string;
  category: PerfCategory;
  /** 目標タイム(ms)。docs/perf/dashboard.md の目標時間ポリシーに沿って設定する。 */
  targetMs: number;
  /** 目標値の根拠や計測条件などの補足(任意)。 */
  note?: string;
}

export function recordPerf(testInfo: TestInfo, meta: PerfMeta, ms: number): void {
  testInfo.annotations.push({
    type: "perf",
    description: JSON.stringify({ ...meta, ms, measuredAt: new Date().toISOString() }),
  });
}

/**
 * ページ遷移の所要時間を計測する。第3引数で終点を指定する。
 *
 * - 文字列を渡すと「その要素が見えるまで」を終点にする。
 * - 関数を渡すと「そのPromiseが解決するまで」を終点にする。SSR済みの要素は `load` の時点で
 *   既に存在するため、セレクタ指定では「JSが動いて画面が使える状態になった」ことを判定できない。
 *   実数値の算出など、クライアント処理の完了でしか変わらない状態を待ちたい場合に使う。
 */
export async function timeNav(
  page: Page,
  url: string,
  ready?: string | ((page: Page) => Promise<unknown>),
): Promise<number> {
  const start = Date.now();
  await page.goto(url, { waitUntil: "load" });
  if (typeof ready === "string") {
    await page.waitForSelector(ready, { state: "visible" });
  } else if (ready) {
    await ready(page);
  }
  return Date.now() - start;
}

/** クリック等の単発アクションの所要時間を計測する。fn内で結果の可視化待ち(waitForSelector等)まで行うこと。 */
export async function timeAction(fn: () => Promise<void>): Promise<number> {
  const start = Date.now();
  await fn();
  return Date.now() - start;
}

/** 計測を実行し、結果をレポーターに引き渡すまでを1つにまとめたヘルパー。シナリオファイルからはこれを主に使う。 */
export async function perfScenario(
  testInfo: TestInfo,
  meta: PerfMeta,
  run: () => Promise<number>,
): Promise<void> {
  const ms = await run();
  recordPerf(testInfo, meta, ms);
}
