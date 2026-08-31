import { expect, perfScenario, test, timeNav } from "../lib/perf";

let ownedPokemonId: string;

test.beforeAll(async ({ request }) => {
  const response = await request.get("/api/owned-pokemon?limit=1&offset=0");
  await expect(response).toBeOK();

  const body = (await response.json()) as { data: Array<{ id: string }> };
  expect(body.data.length).toBeGreaterThan(0);
  ownedPokemonId = body.data[0].id;
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
