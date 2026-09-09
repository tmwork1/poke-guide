import { expect, perfScenario, recordPerf, test, timeAction, timeNav } from "../lib/perf";

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

    // クリックから保存完了までは「デバウンス待ち」と「PUTの往復」という性質の違う2区間の和で、
    // 合算値だけでは超過分がどちらに載っているのかが分からない。両方を別々に記録して切り分ける。
    // (2026-09-09以前はこの合算値だけを見て、Pyodideプリフェッチとの競合を主因と説明していた。
    //  プリフェッチ廃止後も値が下がらなかったため、区間を分けて測る形に改めた。)
    //
    // ⚠️ 区間の境目に data-state は使えない。pokemon-edit-panel.ts の scheduleSave() は
    // 入力を受けた瞬間に data-state="saving" を立て(表示は「編集中…」)、700ms後に走る
    // saveNow() も同じ "saving" のまま表示だけ「保存中…」に変える。属性で待つと
    // デバウンス発火前のクリック直後に通過してしまう。表示テキストで分ける手もあるが、
    // ポーリング間隔より速くPUTが終わると「保存中…」を取り逃す。PUT自体のネットワーク
    // タイミング(Request.timing())なら取りこぼしも計測誤差もないのでそちらを使う。
    const autosaveStatus = page.locator("#autosave-status");
    const isAutosavePut = (method: string, url: string): boolean =>
      method === "PUT" && url.includes("/api/owned-pokemon/");
    let requestMs = 0;

    await perfScenario(
      testInfo,
      {
        id: "box-item-select-autosave",
        label: "もちもの選択の自動保存",
        category: "interaction",
        // pokemon-edit-panel.ts の DEBOUNCE_MS = 700 が下限として必ず乗るため、
        // 700ms未満の目標は原理的に達成できない。PUTの往復に500msを見込んで1,200msとする。
        // この目標を下げたいならデバウンス値そのものを見直すことになる(体感の即応性と
        // 保存リクエスト数のトレードオフなので、性能だけでは決められない)。
        targetMs: 1200,
        note:
          "使い捨ての空個体に限定。700msの保存デバウンスとPUTの往復を含む合算値。" +
          "内訳は もちもの保存のPUT往復(デバウンス後だけ)と併せて読む。" +
          "2026-09-01〜09-08はPyodideのバックグラウンド初期化との競合が主因だったが、" +
          "2026-09-09にプリフェッチ自体を廃止し育成タブではPyodideを取得しなくなったため、その説明はもう当てはまらない。",
      },
      () =>
        timeAction(async () => {
          const putResponse = page.waitForResponse((response) =>
            isAutosavePut(response.request().method(), response.url()),
          );
          await page.locator("#item-select-grid button[data-value]:not([data-value=''])").first().click();
          const response = await putResponse;
          // finished() を待たずに timing() を読むと responseEnd がまだ -1 で、
          // 差が負の値になる(実際に -23ms 等が記録された)。本文の受信完了まで待つ。
          await response.finished();
          const timing = response.request().timing();
          requestMs = Math.round(timing.responseEnd - timing.requestStart);
          await expect(autosaveStatus).toHaveAttribute("data-state", "saved");
        }),
    );

    // デバウンス発火からPUT完了までだけを取り出した値。ここが伸びていればサーバー側
    // (APIハンドラ・Supabaseへの書き込み)、伸びていなければデバウンス待ちが支配的と読める。
    recordPerf(
      testInfo,
      {
        id: "box-item-select-autosave-request",
        label: "もちもの保存のPUT往復",
        category: "interaction",
        targetMs: 500,
        note:
          "もちもの選択の自動保存 の内訳。表示が「保存中…」になってから data-state=saved になるまでで、" +
          "700msのデバウンス待ちを含まない。合算値との差がデバウンス側の実測になる。",
      },
      requestMs,
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
