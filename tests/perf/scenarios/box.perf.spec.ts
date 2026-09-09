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
      note:
        "実数値6値が算出されるまでを終点にする。#edit-shell はSSR済みで load 時点に存在するため終点にならない。" +
        "Pyodideのプリフェッチは表示3秒後に始まるので load より後であり、この値には含まれない。",
    },
    () =>
      timeNav(page, `/box/${encodeURIComponent(ownedPokemonId)}`, (target) =>
        // 実数値は種族値マスタ(pokemon-core.json)の取得後に recalcStats() が書き込む。
        // 「編集画面が使える状態になった」ことを、production/dev どちらでも同じ基準で判定できる。
        target.waitForFunction(() => /^\d+$/.test(document.getElementById("stat-hp")?.textContent?.trim() ?? "")),
      ),
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
      note: "wrangler.jsonc の OPGG_USAGE KVを remote: false に変更し、旧既知バグ(/api/opgg-usage系の同時リクエスト詰まり、backlog 2026-08-31)は解消済み(2026-09-08)。",
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
      note: "ローカルdev(remote: falseのOPGG_USAGE)では集計データが空のため「集計データがまだありません。」の空状態表示になる。カード描画・空状態表示のどちらかを読み込み完了とみなす。",
    },
    () =>
      timeNav(
        page,
        `/box/matchup?pokemon=${encodeURIComponent(ownedPokemonId)}`,
        "#box-matchup-list:not([aria-busy]) .team-matchup-card, #box-matchup-status:not([hidden])",
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
        note:
          "使い捨ての空個体に限定。700msの保存デバウンスとPUT完了を含む。" +
          "2026-09-01〜09-08は「表示直後に始まるPyodideのバックグラウンド初期化が保存と競合する」ことが主因で、" +
          "ENGINE_PREFETCH_FLOOR_MSを1500ms→3000msに引き上げて2672ms→966msまで改善させていた。" +
          "2026-09-09にプリフェッチ自体を廃止し、育成タブではPyodideを一切取得しなくなった" +
          "(実測で6秒待ってもCDN/wheelへのリクエスト0件)ため、この説明はもう当てはまらない。" +
          "残っているのはデバウンス700ms+PUTの往復で、超過分の切り分けは未了(follow-up)",
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
