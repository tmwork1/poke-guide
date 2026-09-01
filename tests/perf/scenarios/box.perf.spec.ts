import { expect, perfScenario, test, timeAction, timeNav } from "../lib/perf";

let ownedPokemonId: string;
let dialogOwnedPokemonId: string;
const disposableOwnedPokemonIds: string[] = [];

test.beforeAll(async ({ request }) => {
  const response = await request.get("/api/owned-pokemon?limit=1&offset=0");
  await expect(response).toBeOK();

  const body = (await response.json()) as { data: Array<{ id: string }> };
  expect(body.data.length).toBeGreaterThan(0);
  ownedPokemonId = body.data[0].id;

  const dialogResponse = await request.get("/api/owned-pokemon?limit=48&offset=0");
  await expect(dialogResponse).toBeOK();
  const dialogBody = (await dialogResponse.json()) as { data: Array<{ id: string; item_name: string | null }> };
  // メガストーンで固定されている個体では持ち物ボタンがdisabledになるため、既存データを
  // 変更せずに開閉だけ確認できる通常の個体を選ぶ。
  const dialogSafePokemon = dialogBody.data.find((pokemon) => !/ナイト[XYZ]?$/.test(pokemon.item_name ?? ""));
  expect(dialogSafePokemon).toBeDefined();
  dialogOwnedPokemonId = dialogSafePokemon!.id;
});

test.afterAll(async ({ request }) => {
  if (disposableOwnedPokemonIds.length === 0) return;

  const response = await request.get("/api/owned-pokemon?limit=48&offset=0");
  await expect(response).toBeOK();
  const body = (await response.json()) as { data: Array<{ id: string }> };
  const remainingDisposableIds = body.data.filter((pokemon) => disposableOwnedPokemonIds.includes(pokemon.id));
  // DELETEの成功だけを信用せず、一覧GETで今回作成した個体が0件であることを確認する。
  expect(remainingDisposableIds).toHaveLength(0);
});

test("ボックス一覧を表示", async ({ page }, testInfo) => {
  await perfScenario(
    testInfo,
    {
      id: "box-index-load",
      label: "ボックス一覧を表示",
      category: "page-load",
      targetMs: 1500,
    },
    () => timeNav(page, "/box", "#owned-pokemon-list a[href^='/box/']"),
  );
});

test("個体詳細を表示", async ({ page }, testInfo) => {
  await perfScenario(
    testInfo,
    {
      id: "box-detail-load",
      label: "個体詳細を表示",
      category: "page-load",
      targetMs: 5000,
      note: "Pyodide のダメージ計算エンジン初期化を含む",
    },
    () => timeNav(page, `/box/${encodeURIComponent(ownedPokemonId)}`, "#edit-shell"),
  );
});

test("バトルデータを表示", async ({ page }, testInfo) => {
  await perfScenario(
    testInfo,
    {
      id: "box-data-load",
      label: "バトルデータを表示",
      category: "page-load",
      targetMs: 1500,
      note: "既知の未解決bug: /api/opgg-usage系が同時リクエストでdevサーバー側に詰まる(backlog, 2026-08-31)",
    },
    () => timeNav(page, `/box/data?pokemon=${encodeURIComponent(ownedPokemonId)}`, "#mobile-training-ui"),
  );
});

test("相性チェックを表示", async ({ page }, testInfo) => {
  await perfScenario(
    testInfo,
    {
      id: "box-matchup-load",
      label: "相性チェックを表示",
      category: "page-load",
      targetMs: 1500,
    },
    () =>
      timeNav(
        page,
        `/box/matchup?pokemon=${encodeURIComponent(ownedPokemonId)}`,
        "#box-matchup-list:not([aria-busy])",
      ),
  );
});

test("上位チームを表示", async ({ page }, testInfo) => {
  await perfScenario(
    testInfo,
    {
      id: "box-ranked-load",
      label: "上位チームを表示",
      category: "page-load",
      targetMs: 1500,
    },
    () =>
      timeNav(
        page,
        `/box/ranked?pokemon=${encodeURIComponent(ownedPokemonId)}`,
        "#ranked-data-panel .box-ranked-results, #ranked-data-status:not([data-state='loading'])",
      ),
  );
});

test("もちもの選択モーダルを閉じる", async ({ page }, testInfo) => {
  await timeNav(page, `/box/${encodeURIComponent(dialogOwnedPokemonId)}`, "#edit-shell");

  const trigger = page.locator("#item-dropdown-button");
  const dialog = page.locator("#item-select-dialog");
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(dialog).toBeVisible();

  await perfScenario(
    testInfo,
    {
      id: "box-item-dialog-close",
      label: "もちもの選択モーダルを閉じる",
      category: "close",
      targetMs: 300,
      note: "既存個体では候補を選ばず、表示のみのダイアログを閉じる操作に限定",
    },
    () =>
      timeAction(async () => {
        await page.locator("#item-select-close-button").click();
        await expect(dialog).toBeHidden();
      }),
  );
});

test("使い捨て個体のもちものを選択して自動保存する", async ({ page, request }, testInfo) => {
  const createResponse = await request.post("/api/owned-pokemon", {
    headers: { Origin: "http://localhost:4321" },
    data: {},
  });
  await expect(createResponse).toBeOK();
  const createBody = (await createResponse.json()) as { data: { id: string } };
  const disposableId = createBody.data.id;
  disposableOwnedPokemonIds.push(disposableId);

  try {
    await timeNav(page, `/box/${encodeURIComponent(disposableId)}`, "#edit-shell");
    await page.locator("#item-dropdown-button").click();
    await expect(page.locator("#item-select-dialog")).toBeVisible();

    await perfScenario(
      testInfo,
      {
        id: "box-item-select-autosave",
        label: "もちもの選択の自動保存",
        category: "interaction",
        targetMs: 800,
        note: "使い捨ての空個体に限定。700msの保存デバウンスとPUT完了を含む。主因はopgg-usage同時リクエストではなく、ページ表示直後に開始するPyodide/jpokeエンジンのバックグラウンド初期化がメインスレッドを塞ぎ保存処理と競合すること(2026-09-01調査)。pyodide-engine.tsのENGINE_PREFETCH_FLOOR_MSを1500ms→3000msに引き上げ、本シナリオの一連の流れ(表示〜保存完了、概ね2秒)とプリフェッチ開始が重ならないようにした結果、2672ms→966ms前後まで改善(🔴→🟡)。根本対応にはPyodide初期化のWorker化等が必要(follow-up)",
      },
      () =>
        timeAction(async () => {
          await page.locator("#item-select-grid button[data-value]:not([data-value=''])").first().click();
          const autosaveStatus = page.locator("#autosave-status");
          await expect(autosaveStatus).toHaveAttribute("data-state", "saving");
          await expect(autosaveStatus).toHaveAttribute("data-state", "saved");
        }),
    );
  } finally {
    const deleteResponse = await request.delete(`/api/owned-pokemon/${encodeURIComponent(disposableId)}`, {
      headers: { Origin: "http://localhost:4321" },
    });
    await expect(deleteResponse).toBeOK();

    const listResponse = await request.get("/api/owned-pokemon?limit=48&offset=0");
    await expect(listResponse).toBeOK();
    const listBody = (await listResponse.json()) as { data: Array<{ id: string }> };
    expect(listBody.data.filter((pokemon) => pokemon.id === disposableId)).toHaveLength(0);
  }
});
