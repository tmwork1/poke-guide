import { expect, perfScenario, test, timeAction, type PerfMeta } from "../lib/perf";
import type { Page } from "@playwright/test";

type TeamListResponse = {
  teams?: Array<{ id?: string }>;
};

type CreatedTeamResponse = {
  team?: { id?: string };
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

async function createDisposableTeam(page: Page): Promise<string> {
  // APIRequestContext は Origin ヘッダーがテストサーバーの origin と一致しないため、
  // CSRF 対策済みの POST はブラウザの same-origin fetch で行う。
  await page.goto("/team/new", { waitUntil: "load" });
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/teams", { method: "POST", credentials: "same-origin" });
    return { status: response.status, body: await response.json() };
  });
  expect(result.status).toBe(201);
  const body = result.body as CreatedTeamResponse;
  expect(body.team?.id).toEqual(expect.any(String));
  return body.team!.id!;
}

async function deleteDisposableTeamAndVerify(page: Page, teamId: string): Promise<void> {
  const deleteResponse = await page.request.delete(`/api/teams/${encodeURIComponent(teamId)}`, {
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(deleteResponse.status()).toBe(200);

  const getResponse = await page.request.get(`/api/teams/${encodeURIComponent(teamId)}`);
  expect(getResponse.status()).toBe(404);
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

test("チームのもちもの表示を閉じる", async ({ page }, testInfo) => {
  const existingTeamId = await getExistingTeamId(page);
  test.skip(!existingTeamId, "既存チームがないため、既存フィクスチャを変更しない開閉計測を実行できない");

  await page.goto(`/team/${encodeURIComponent(existingTeamId!)}`, { waitUntil: "load" });
  await page.waitForFunction((selector) => document.querySelector<HTMLElement>(selector)?.hidden === true, "#select-loading-message");

  await page.locator("#team-item-redistribute-button").click();
  const dialog = page.locator("#team-item-redistribute-dialog");
  await dialog.waitFor({ state: "visible" });

  const meta: PerfMeta = {
    id: "team-item-dialog-close",
    label: "チームのもちもの表示を閉じる",
    category: "close",
    targetMs: 300,
    note: "開閉は自動保存を呼ばないことを実装で確認済み。既存チームでは選択・変更を行わない。",
  };

  await perfScenario(testInfo, meta, () =>
    timeAction(async () => {
      await page.locator("#team-item-redistribute-close").click();
      await dialog.waitFor({ state: "hidden" });
    }),
  );
});

test("使い捨てチームのメモを編集して自動保存を完了する", async ({ page }, testInfo) => {
  const teamId = await createDisposableTeam(page);

  try {
    await page.goto(`/team/${encodeURIComponent(teamId)}`, { waitUntil: "load" });
    const memo = page.locator("#team-memo");
    await memo.waitFor({ state: "visible" });

    const meta: PerfMeta = {
      id: "team-composition-autosave",
      label: "チームメモ編集と自動保存",
      category: "interaction",
      targetMs: 800,
      note: "使い捨てチームでのみメモを変更し、700msデバウンス後のPUT完了までを計測する。",
    };

    await perfScenario(testInfo, meta, () =>
      timeAction(async () => {
        const saveResponse = page.waitForResponse((response) =>
          response.request().method() === "PUT" && response.url().includes(`/api/teams/${teamId}`) && response.ok(),
        );
        await memo.fill("performance test");
        await saveResponse;
      }),
    );
  } finally {
    await deleteDisposableTeamAndVerify(page, teamId);
  }
});
