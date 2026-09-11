import { expect, perfScenario, recordPerf, test, timeAction, timeNav, type PerfMeta } from "../lib/perf";
import type { Page } from "@playwright/test";

type TeamListResponse = {
  teams?: Array<{ id?: string }>;
};

type CreatedTeamResponse = {
  team?: { id?: string };
};

type OwnedPokemonListResponse = {
  data: Array<{ id: string }>;
  hasMore: boolean;
};

type RankedTeamsResponse = {
  teams: Array<{
    members: Array<{ speciesKey?: string | null }>;
  }>;
  hasMore: boolean;
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

/**
 * チーム詳細はSSRで初期データを描画するため、実在する編集レイアウトが表示された時点までを計測する。
 */
async function timeLoadUntilTeamLayoutVisible(page: Page, url: string): Promise<number> {
  return timeAction(async () => {
    await page.goto(url, { waitUntil: "load" });
    await page.locator("#team-edit-layout").waitFor({ state: "visible" });
  });
}

// 各シナリオは finally で使い捨てデータを消すが、テスト本体がタイムアウトしたときは
// その finally 自体もタイムアウト済みの時計の上で走るため削除が完走せず、ローカルDBに
// ゴミチームが溜まる(実際に10件残り、/team 一覧の計測値まで汚した)。afterAll は独自の
// タイムアウトを持つので、ここを最後の砦にして消し残しを回収する。
const disposableTeamIds = new Set<string>();
const disposableOwnedPokemonIds = new Set<string>();

test.afterAll(async ({ request }) => {
  for (const teamId of disposableTeamIds) {
    await request.delete(`/api/teams/${encodeURIComponent(teamId)}`, { headers: { Origin: "http://localhost:4321" } });
  }
  for (const ownedPokemonId of disposableOwnedPokemonIds) {
    await request.delete(`/api/owned-pokemon/${encodeURIComponent(ownedPokemonId)}`, {
      headers: { Origin: "http://localhost:4321" },
    });
  }
  disposableTeamIds.clear();
  disposableOwnedPokemonIds.clear();
});

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
  disposableTeamIds.add(body.team!.id!);
  return body.team!.id!;
}

async function deleteDisposableTeamAndVerify(page: Page, teamId: string): Promise<void> {
  const deleteResponse = await page.request.delete(`/api/teams/${encodeURIComponent(teamId)}`, {
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(deleteResponse.status()).toBe(200);
  disposableTeamIds.delete(teamId);

  // DELETE の200だけでは削除完了を信用しない。ユーザーの既存チームを対象にしない
  // 使い捨てデータだからこそ、一覧からも消えたことまで確認する。
  const listResponse = await page.request.get("/api/teams");
  await expect(listResponse).toBeOK();
  const body = (await listResponse.json()) as TeamListResponse;
  expect(body.teams?.some((team) => team.id === teamId)).toBeFalsy();
}

async function deleteDisposableOwnedPokemonAndVerify(page: Page, ownedPokemonId: string): Promise<void> {
  const deleteResponse = await page.request.delete(`/api/owned-pokemon/${encodeURIComponent(ownedPokemonId)}`, {
    headers: { Origin: new URL(page.url()).origin },
  });
  await expect(deleteResponse).toBeOK();
  disposableOwnedPokemonIds.delete(ownedPokemonId);

  let offset = 0;
  while (true) {
    const listResponse = await page.request.get(`/api/owned-pokemon?limit=48&offset=${offset}`);
    await expect(listResponse).toBeOK();
    const body = (await listResponse.json()) as OwnedPokemonListResponse;
    expect(body.data.some((pokemon) => pokemon.id === ownedPokemonId)).toBeFalsy();
    if (!body.hasMore || body.data.length === 0) break;
    offset += body.data.length;
  }
}

async function createDisposableTeamWithRankedMember(page: Page): Promise<{ teamId: string; ownedPokemonId: string }> {
  const teamId = await createDisposableTeam(page);
  let ownedPokemonId: string | undefined;
  try {
    // SSRが選んだ現行シーズンの実在種族を使う。固定の種族名ではローカルの順位データに
    // 存在しない場合があり、「最初の24件を表示」の終点を空状態で通過してしまうため。
    const teamPageResponse = await page.request.get(`/team/${encodeURIComponent(teamId)}`);
    await expect(teamPageResponse).toBeOK();
    const teamPageHtml = await teamPageResponse.text();
    const season = /data-ranked-season="([^"]+)"/.exec(teamPageHtml)?.[1];
    expect(season).toBeTruthy();

    const rankedResponse = await page.request.get(
      `/api/ranked-teams?season=${encodeURIComponent(season!)}&limit=24&offset=0`,
    );
    await expect(rankedResponse).toBeOK();
    const rankedBody = (await rankedResponse.json()) as RankedTeamsResponse;

    // メガシンカ後の種族はもちものがメガストーンに固定され、もちもの入替ダイアログでは
    // 枠が is-locked / aria-disabled になってタップを一切受け付けない(team/[id].astro の
    // loadRedistributionLocks)。ランキング1位のチームがたまたまメガを含むかどうかで
    // シナリオが落ちるのを避けるため、メガストーン対象の種族は最初から除外して選ぶ。
    const megaStonesResponse = await page.request.get("/master-data/autocomplete/mega-stones.json");
    await expect(megaStonesResponse).toBeOK();
    const megaSpecies = new Set(
      ((await megaStonesResponse.json()) as Array<{ species: string }>).map((entry) => entry.species),
    );
    const speciesName = rankedBody.teams
      .flatMap((team) => team.members)
      .map((member) => member.speciesKey)
      .find((key): key is string => Boolean(key) && !megaSpecies.has(key!));
    expect(speciesName).toBeTruthy();

    const createResponse = await page.request.post("/api/owned-pokemon", {
      headers: { Origin: new URL(page.url()).origin },
      data: {
        species_name: speciesName,
        level: 50,
        nature: null,
        ability_name: null,
        item_name: null,
        tera_type: null,
        evs: [0, 0, 0, 0, 0, 0],
        ivs: [31, 31, 31, 31, 31, 31],
        move_names: [],
        memo: null,
        tags: [],
      },
    });
    await expect(createResponse).toBeOK();
    const createBody = (await createResponse.json()) as { data: { id: string } };
    ownedPokemonId = createBody.data.id;
    if (!ownedPokemonId) throw new Error("使い捨て個体のIDを取得できませんでした。");
    disposableOwnedPokemonIds.add(ownedPokemonId);

    const updateResponse = await page.request.put(`/api/teams/${encodeURIComponent(teamId)}`, {
      headers: { Origin: new URL(page.url()).origin },
      data: {
        memo: null,
        members: [{ slot: 1, owned_pokemon_id: ownedPokemonId, item_override: null }],
      },
    });
    await expect(updateResponse).toBeOK();
    return { teamId, ownedPokemonId };
  } catch (error) {
    await deleteDisposableTeamAndVerify(page, teamId);
    if (ownedPokemonId) await deleteDisposableOwnedPokemonAndVerify(page, ownedPokemonId);
    throw error;
  }
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

  await perfScenario(testInfo, meta, () => timeLoadUntilTeamLayoutVisible(page, url));
});

test("上位チームの読み込み", async ({ page }, testInfo) => {
  const meta: PerfMeta = {
    id: "ranked-teams-load",
    label: "上位チームの表示",
    category: "page-load",
    targetMs: 1500,
    note: "/ranked-teams から /data/top-builds へのリダイレクト後を計測。wrangler.jsonc の OPGG_USAGE KVを remote: false に変更し、旧既知バグ(/api/opgg-usage系の同時リクエスト詰まり、backlog 2026-08-31)は解消済み(2026-09-08)。",
  };

  await perfScenario(testInfo, meta, () => timeLoadUntilLoadingHidden(page, "/ranked-teams", "#top-builds-loading"));
});

test("チームのもちもの表示を閉じる", async ({ page }, testInfo) => {
  const existingTeamId = await getExistingTeamId(page);
  test.skip(!existingTeamId, "既存チームがないため、既存フィクスチャを変更しない開閉計測を実行できない");

  await page.goto(`/team/${encodeURIComponent(existingTeamId!)}`, { waitUntil: "load" });
  await page.locator("#team-edit-layout").waitFor({ state: "visible" });

  const teamUpdateRequests: string[] = [];
  const teamUpdateUrl = `/api/teams/${encodeURIComponent(existingTeamId!)}`;
  const onRequest = (request: { method(): string; url(): string }) => {
    if (request.method() === "PUT" && request.url().includes(teamUpdateUrl)) {
      teamUpdateRequests.push(request.url());
    }
  };
  page.on("request", onRequest);

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

  try {
    await perfScenario(testInfo, meta, () =>
      timeAction(async () => {
        await page.locator("#team-item-redistribute-close").click();
        await dialog.waitFor({ state: "hidden" });
      }),
    );

    // 700ms の自動保存デバウンスを越えても、開閉だけでは既存チームへの PUT がないことを確認する。
    await page.waitForTimeout(800);
    expect(teamUpdateRequests).toEqual([]);
  } finally {
    page.off("request", onRequest);
  }
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

test("編成タブの枠タップで選択状態になる", async ({ page }, testInfo) => {
  const { teamId, ownedPokemonId } = await createDisposableTeamWithRankedMember(page);

  try {
    await timeNav(page, `/team/${encodeURIComponent(teamId)}?tab=formation`, "#team-formation-mobile-slots button[data-slot='2']");
    const slot = page.locator("#team-formation-mobile-slots button[data-slot='2']");

    await perfScenario(
      testInfo,
      {
        id: "team-formation-slot-select",
        label: "編成タブの枠を選択",
        category: "interaction",
        targetMs: 300,
        note: "枠タップはフィードバックを返す通常の操作なので、RAILのinteraction目安300msを目標にする。",
      },
      () =>
        timeAction(async () => {
          await slot.click();
          // team-mate-card.ts は onSlotDoubleTap の有無にかかわらずclick後250ms待って
          // onSlotTap を呼ぶ。onFormationSlotTap 後の再描画で付く is-selected はその待機を
          // 必ず通過したあとだけ観測できるため、遅延を丸ごと含む終点にする。
          await expect(slot).toHaveClass(/is-selected/);
          await expect(slot).toHaveAttribute("aria-pressed", "true");
        }),
    );
  } finally {
    await deleteDisposableTeamAndVerify(page, teamId);
    await deleteDisposableOwnedPokemonAndVerify(page, ownedPokemonId);
  }
});

test("もちもの入替ダイアログの枠タップで選択状態になる", async ({ page }, testInfo) => {
  const { teamId, ownedPokemonId } = await createDisposableTeamWithRankedMember(page);

  try {
    await timeNav(page, `/team/${encodeURIComponent(teamId)}`, "#team-item-redistribute-button");
    await page.locator("#team-item-redistribute-button").click();
    await page.locator("#team-item-redistribute-dialog").waitFor({ state: "visible" });
    const slot = page.locator("#team-item-redistribute-members button[data-slot='1']");
    const selectedItem = page.locator("#team-item-redistribute-item-row button[data-slot='1']");
    await slot.waitFor({ state: "visible" });

    await perfScenario(
      testInfo,
      {
        id: "team-item-redistribute-slot-select",
        label: "もちもの入替の枠を選択",
        category: "interaction",
        targetMs: 300,
        note: "枠タップはフィードバックを返す通常の操作なので、RAILのinteraction目安300msを目標にする。",
      },
      () =>
        timeAction(async () => {
          await slot.click();
          // ダイアログ側も team-mate-card.ts の250msタイマーを通る。onRedistributionMemberTap
          // が再描画した直後にだけ、対応するもちもの枠へ is-selected が付くため、ここを終点に
          // すればタイマー待機を測定から取りこぼさない。
          await expect(selectedItem).toHaveClass(/is-selected/);
        }),
    );
  } finally {
    await deleteDisposableTeamAndVerify(page, teamId);
    await deleteDisposableOwnedPokemonAndVerify(page, ownedPokemonId);
  }
});

test("データタブで類似チームの最初の24件を表示する", async ({ page }, testInfo) => {
  const { teamId, ownedPokemonId } = await createDisposableTeamWithRankedMember(page);
  let firstPageSize = 0;
  let resolveFirstPage: (() => void) | undefined;
  const firstPage = new Promise<void>((resolve) => {
    resolveFirstPage = resolve;
  });
  const onResponse = async (response: {
    url(): string;
    request(): { method(): string };
    json(): Promise<unknown>;
    finished(): Promise<Error | null>;
  }) => {
    if (response.request().method() !== "GET" || !response.url().includes("/api/ranked-teams?")) return;
    if (firstPageSize !== 0) return;
    // response.json() は本文が破棄済みだと Protocol error (Network.getResponseBody) を投げる。
    // finished() を待ってから読み、それでも取れなかった分は終点判定に使わず次のレスポンスへ譲る。
    let body: RankedTeamsResponse;
    try {
      await response.finished();
      body = (await response.json()) as RankedTeamsResponse;
    } catch {
      return;
    }
    firstPageSize = body.teams.length;
    resolveFirstPage?.();
  };
  page.on("response", onResponse);

  try {
    await perfScenario(
      testInfo,
      {
        id: "team-data-first-page",
        label: "データタブ: 類似チームの最初の24件を表示",
        category: "page-load",
        targetMs: 1500,
        note: "初期表示の体感を測る。通常の画面遷移としてRAILのpage-load目安1500msを目標にする。",
      },
      () =>
        timeNav(page, `/team/${encodeURIComponent(teamId)}?tab=data`, async (target) => {
          await firstPage;
          // 1ページ=24件はAPI側の上限であって下限ではない。ローカルDBのranked_teamsが
          // 24件未満なら1回で全件が返るため、件数そのものではなく「1件以上返った」ことだけを主張する。
          expect(firstPageSize).toBeGreaterThan(0);
          // 類似度で絞る画面なので、24件すべてがカードになるとは限らない。最初の24件の
          // レスポンスを受け、カードまたは明示的な空状態が描画された時点を表示完了とする。
          await target.waitForFunction(() => {
            const root = document.getElementById("team-data-mobile-similar");
            return !!root && (root.querySelector(".team-grid") !== null || root.querySelector(".team-data-similar-status:not([data-state='loading'])") !== null);
          });
        }),
    );
  } finally {
    page.off("response", onResponse);
    await deleteDisposableTeamAndVerify(page, teamId);
    await deleteDisposableOwnedPokemonAndVerify(page, ownedPokemonId);
  }
});

test("データタブの類似チーム自動継続読み込みを完了する", async ({ page }, testInfo) => {
  const { teamId, ownedPokemonId } = await createDisposableTeamWithRankedMember(page);
  let rankedRequestCount = 0;
  let resolveComplete: (() => void) | undefined;
  const complete = new Promise<void>((resolve) => {
    resolveComplete = resolve;
  });
  const onResponse = async (response: {
    url(): string;
    request(): { method(): string };
    json(): Promise<unknown>;
    finished(): Promise<Error | null>;
  }) => {
    if (response.request().method() !== "GET" || !response.url().includes("/api/ranked-teams?")) return;
    rankedRequestCount += 1;
    // response.json() は本文が破棄済みだと Protocol error (Network.getResponseBody) を投げる。
    // finished() を待ってから読み、取れなかった分は hasMore の判定に使わない
    // (最終ページを取り逃すとタイムアウトするが、誤って早期に完了扱いにするよりは安全)。
    let body: RankedTeamsResponse;
    try {
      await response.finished();
      body = (await response.json()) as RankedTeamsResponse;
    } catch {
      return;
    }
    if (!body.hasMore) resolveComplete?.();
  };
  page.on("response", onResponse);

  try {
    await perfScenario(
      testInfo,
      {
        id: "team-data-autoload-complete",
        label: "データタブ: 類似チームの自動継続読み込みを完了",
        category: "page-load",
        targetMs: 5000,
        note: "最初の表示ではなく、24件ずつの自動継続取得・全件描画が終わるまでのネットワーク総コストを示す指標。",
      },
      () =>
        timeNav(page, `/team/${encodeURIComponent(teamId)}?tab=data`, async (target) => {
          await complete;
          // 最終レスポンスを受けたあと、loadMoreSimilarBuilds() のDOM反映までを含める。
          await target.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        }),
    );

    // 回数は時間ではないので recordPerf に混ぜない。発見Cの「24件ずつ40回超」を
    // 監視しつつ、将来のページング方針を縛りすぎない上限として60回を主張する。
    // 実測値は失敗時のexpect出力で確認でき、dashboardのms列を異種の数値で汚さない。
    expect(rankedRequestCount).toBeLessThanOrEqual(60);
  } finally {
    page.off("response", onResponse);
    await deleteDisposableTeamAndVerify(page, teamId);
    await deleteDisposableOwnedPokemonAndVerify(page, ownedPokemonId);
  }
});
