import { expect, perfScenario, test, timeAction, type PerfMeta } from "../lib/perf";
import type { Page } from "@playwright/test";

type TeamListResponse = {
  teams?: Array<{ id?: string }>;
};

/**
 * ページ内の非同期一覧が初期表示を完了し、ローディング表示が消えた時点までを計測する。
 * エラー時にもローディングは消えるため、データの有無によらず待機条件として使える。
 */
async function timeLoadUntilLoadingHidden(page: Page, url: string, loadingSelector: string): Promise<number> {
  return timeAction(async () => {
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction((selector) => document.querySelector<HTMLElement>(selector)?.hidden === true, loadingSelector);
  });
}

async function getExistingTeamId(page: Page): Promise<string | undefined> {
  const response = await page.request.get("/api/teams");
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as TeamListResponse;
  return body.teams?.find((team) => typeof team.id === "string")?.id;
}

test("チーム一覧の読み込み", async ({ page }, testInfo) => {
  const meta: PerfMeta = {
    id: "team-index-load",
    label: "チーム一覧の表示",
    category: "page-load",
    targetMs: 1500,
  };

  await perfScenario(testInfo, meta, () => timeLoadUntilLoadingHidden(page, "/team", "#loading-message"));
});

test("チーム詳細の読み込み", async ({ page }, testInfo) => {
  const existingTeamId = await getExistingTeamId(page);
  const url = existingTeamId ? `/team/${encodeURIComponent(existingTeamId)}` : "/team/new";
  const meta: PerfMeta = {
    id: "team-detail-load",
    label: "チーム詳細の表示",
    category: "page-load",
    targetMs: 1500,
    ...(existingTeamId ? {} : { note: "既存チームがないため、新規チームの空表示を計測" }),
  };

  await perfScenario(testInfo, meta, () => timeLoadUntilLoadingHidden(page, url, "#select-loading-message"));
});

test("上位チームの読み込み", async ({ page }, testInfo) => {
  const meta: PerfMeta = {
    id: "ranked-teams-load",
    label: "上位チームの表示",
    category: "page-load",
    targetMs: 1500,
    note: "/ranked-teams から /data/top-builds へのリダイレクト後を計測。既知の未解決bug: /api/opgg-usage系が同時リクエストでdevサーバー側に詰まる(backlog, 2026-08-31)",
  };

  await perfScenario(testInfo, meta, () => timeLoadUntilLoadingHidden(page, "/ranked-teams", "#top-builds-loading"));
});
