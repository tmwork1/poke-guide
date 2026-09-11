import { expect, perfScenario, recordPerf, test, timeAction, timeNav } from "../lib/perf";

let ownedPokemonId: string;
let dialogOwnedPokemonId: string;
let ownedPokemonCount: number;
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

  // box/index.astro の loadList() と同じ48件単位で全件数を事前に取得する。
  // 一覧画面は hasMorePokemon が false になるまで requestAnimationFrame 経由で loadList() を継続し、
  // 各バッチ後に renderList() が全リンクを再構築する。この件数までリンクが揃った時点だけが最終描画後である。
  ownedPokemonCount = 0;
  let offset = 0;
  while (true) {
    const pageResponse = await request.get(`/api/owned-pokemon?limit=48&offset=${offset}`);
    await expect(pageResponse).toBeOK();
    const pageBody = (await pageResponse.json()) as { data: Array<{ id: string }>; hasMore: boolean };
    ownedPokemonCount += pageBody.data.length;
    if (!pageBody.hasMore) break;
    // hasMore=trueなのに空配列なら、以降のoffsetが進まず無限ループになるため明示的に失敗させる。
    expect(pageBody.data.length).toBeGreaterThan(0);
    offset += pageBody.data.length;
  }
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

test("ボックス一覧の全件読み込みを完了する", async ({ page }, testInfo) => {
  await perfScenario(
    testInfo,
    {
      id: "box-index-load-until-settled",
      label: "ボックス一覧の全件読み込み",
      category: "page-load",
      targetMs: 1500,
      note:
        "loadList() の自動継続読み込みが hasMorePokemon=false で止まり、最終バッチ後の renderList() が全件を再構築し終えるまでを計測する。" +
        "この値はローカルDBの所持件数に依存する。件数が1バッチ(48件)以下では box-index-load とほぼ同値になる。" +
        "通常のページ遷移としてRAIL目安の1500msを目標にする。",
    },
    () =>
      timeNav(page, "/box", (target) =>
        // loadList() 内部の hasMorePokemon はクロージャーでDOMへ公開されないため、
        // 事前に取得した全件数と一致するリンク数を最終バッチの描画完了条件にする。
        target.waitForFunction(
          (count) => document.querySelectorAll("#owned-pokemon-list a[href^='/box/']").length === count,
          ownedPokemonCount,
        ),
      ),
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

test("使い捨て個体のダメージ表を初回表示する", async ({ page, request }, testInfo) => {
  const createResponse = await request.post("/api/owned-pokemon", {
    headers: { Origin: "http://localhost:4321" },
    data: {
      species_name: "ピカチュウ",
      level: 50,
      nature: "おくびょう",
      ability_name: "せいでんき",
      item_name: "でんきだま",
      tera_type: "でんき",
      evs: [0, 0, 0, 32, 0, 32],
      ivs: [31, 31, 31, 31, 31, 31],
      move_names: ["10まんボルト"],
      memo: null,
      tags: [],
    },
  });
  await expect(createResponse).toBeOK();
  const createBody = (await createResponse.json()) as { data: { id: string } };
  const disposableId = createBody.data.id;
  disposableOwnedPokemonIds.push(disposableId);

  const opponentNotes = [
    { name: "カイリュー", nature: "いじっぱり", abilityName: "マルチスケイル", itemName: "こだわりハチマキ", teraType: "ノーマル", moveName: "しんそく" },
    { name: "パオジアン", nature: "ようき", abilityName: "わざわいのつるぎ", itemName: "きあいのタスキ", teraType: "ゴースト", moveName: "つららおとし" },
    { name: "サーフゴー", nature: "ひかえめ", abilityName: "おうごんのからだ", itemName: "たべのこし", teraType: "みず", moveName: "ゴールドラッシュ" },
  ];

  try {
    for (const [index, opponent] of opponentNotes.entries()) {
      const { moveName, ...opponentBuild } = opponent;
      const noteResponse = await request.post("/api/opponent-notes", {
        headers: { Origin: "http://localhost:4321" },
        data: {
          owned_pokemon_id: disposableId,
          opponent_build: {
            ...opponentBuild,
            level: 50,
            evs: [0, 0, 0, 32, 0, 32],
            ivs: [31, 31, 31, 31, 31, 31],
          },
          field: {
            direction: "defense",
            attacks: [{ moveName, hitCount: 1 }],
            order: index * 1000,
          },
          // field.attacks が描画・計算に使うため、トップレベルのmove_nameは不要。
          // nullならPOST時の匿名二重記録はAPI実装によりスキップされる。
          move_name: null,
          client_result: null,
          memo: null,
        },
      });
      await expect(noteResponse).toBeOK();
    }

    // 結果描画後の自動保存は、匿名のdamage_calcs/eventsへ副次記録を作る。
    // 終点は保存開始前に描画される数値なので、使い捨て個体以外へテスト痕跡を残さないよう
    // このPUTだけを成功応答に差し替える(計算・描画の区間には影響しない)。
    await page.route("**/api/opponent-notes/*", async (route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      await route.fulfill({ contentType: "application/json", body: '{"data":{}}' });
    });

    await perfScenario(
      testInfo,
      {
        id: "box-damage-load",
        label: "ダメージ表を初回表示",
        category: "page-load",
        targetMs: 5000,
        note:
          "使い捨て個体に保存済み相手カードを3枚作成し、各カードの累計ダメージに数値が表示されるまでを計測する。" +
          "?tab=damage の初期表示で、ページ内のPyodideエンジンは未初期化(3秒後のプリフェッチから開始)という前提の初回表示を測る。" +
          "Pyodide初期化を伴うpage-loadのRAIL目安に従い5000msを目標にする。",
      },
      () =>
        timeNav(page, `/box/${encodeURIComponent(disposableId)}?tab=damage`, (target) =>
          target.waitForFunction(() => {
            const results = Array.from(document.querySelectorAll<HTMLElement>(".damage-row-total-result"));
            // 初期値の「(計算前)」「(計算エンジンの初期化待ち)」ではなく、
            // 保存した3カードすべてに数値を含む累計結果が出た時点を終点にする。
            return results.length >= 3 && results.every((result) => /\d/.test(result.textContent ?? ""));
          }),
        ),
    );
  } finally {
    const deleteResponse = await request.delete(`/api/owned-pokemon/${encodeURIComponent(disposableId)}`, {
      headers: { Origin: "http://localhost:4321" },
    });
    await expect(deleteResponse).toBeOK();

    const listResponse = await request.get("/api/owned-pokemon?limit=48&offset=0");
    await expect(listResponse).toBeOK();
    const listBody = (await listResponse.json()) as { data: Array<{ id: string }> };
    // 相手カードは owned_pokemon のON DELETE CASCADEで一緒に後始末される。
    expect(listBody.data.filter((pokemon) => pokemon.id === disposableId)).toHaveLength(0);
  }
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
