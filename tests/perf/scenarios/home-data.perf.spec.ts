import { expect, perfScenario, test, timeAction, timeNav } from "../lib/perf";

test("executes a search and displays results", async ({ page }, testInfo) => {
	await page.goto("/search", { waitUntil: "load" });
	await page.waitForSelector("#query", { state: "visible" });

	const query = page.locator("#query");
	const resultsSection = page.locator("#results-section");
	await perfScenario(
		testInfo,
		{
			id: "search-execute",
			label: "検索: 実行して結果を表示",
			category: "interaction",
			targetMs: 800,
			note: "実行のたびに searches/events テーブルへログが1件追加される",
		},
		() =>
			timeAction(async () => {
				await query.fill("ピカチュウ");
				await expect(resultsSection).toBeVisible();
				await expect(page.locator("#result-pokemon li").first()).toBeVisible();
			}),
	);
});

test("ホームを表示する", async ({ page }, testInfo) => {
	await perfScenario(
		testInfo,
		{ id: "home-load", label: "ホーム", category: "page-load", targetMs: 1500 },
		() => timeNav(page, "/", "h1.app-header-title"),
	);

	await expect(page.locator("h1.app-header-title")).toHaveText("ホーム");
});

test("バトルデータを表示する", async ({ page }, testInfo) => {
	await perfScenario(
		testInfo,
		{
				id: "data-index-load",
				label: "バトルデータ",
				category: "page-load",
				targetMs: 1500,
				note: "既知の未解決bug: /api/opgg-usage系が同時リクエストでdevサーバー側に詰まる(backlog, 2026-08-31)",
			},
		() => timeNav(page, "/data", "[data-data-hub-scroll]"),
	);

	await expect(page.locator("[data-data-hub-scroll]")).toBeVisible();
});

test("データ画面のすばやさ表を表示する", async ({ page }, testInfo) => {
	await perfScenario(
		testInfo,
		{ id: "data-speed-chart-load", label: "データ: すばやさ表", category: "page-load", targetMs: 1500 },
		() => timeNav(page, "/data/speed-chart", "#speed-chart-rows"),
	);

	await expect(page.locator("#speed-chart-rows")).toBeVisible();
});

test("データ画面の上位チームを表示する", async ({ page }, testInfo) => {
	await perfScenario(
		testInfo,
		{
				id: "data-top-builds-load",
				label: "データ: 上位チーム",
				category: "page-load",
				targetMs: 1500,
				note: "既知の未解決bug: /api/opgg-usage系が同時リクエストでdevサーバー側に詰まる(backlog, 2026-08-31)",
			},
		() => timeNav(page, "/data/top-builds", ".top-builds-list"),
	);

	await expect(page.locator(".top-builds-list")).toBeVisible();
});

test("すばやさ表を表示する", async ({ page }, testInfo) => {
	await perfScenario(
		testInfo,
		{ id: "speed-chart-load", label: "すばやさ表", category: "page-load", targetMs: 1500 },
		() => timeNav(page, "/speed-chart", "#speed-chart-rows"),
	);

	await expect(page.locator("#speed-chart-rows")).toBeVisible();
});

test("検索画面を表示する", async ({ page }, testInfo) => {
	await perfScenario(
		testInfo,
		{ id: "search-load", label: "検索", category: "page-load", targetMs: 1500 },
		() => timeNav(page, "/search", "#query"),
	);

	await expect(page.locator("#query")).toBeVisible();
});

test("すばやさ表の並び順を切り替える", async ({ page }, testInfo) => {
	await page.goto("/speed-chart", { waitUntil: "load" });
	await page.waitForSelector("#speed-chart-rows", { state: "visible" });

	const orderButton = page.locator("#speed-chart-order-select");
	await perfScenario(
		testInfo,
		{ id: "speed-chart-sort-toggle", label: "すばやさ表: 並び順切替", category: "interaction", targetMs: 300 },
		() =>
			timeAction(async () => {
				await orderButton.click();
				await expect(orderButton).toHaveAttribute("data-order", "asc");
			}),
	);
});
