import { chromium, type FullConfig } from "@playwright/test";

// 各シナリオが page.goto() する画面を、計測開始前に一度ずつ通す。
// 動的ルートは既存ユーザーデータを読んだり変更したりしないダミーIDでも、Astro/Vite が
// そのルートのSSR・クライアントモジュールをコンパイルするため、ウォームアップとして十分である。
const PERF_WARMUP_ROUTES = [
  "/",
  "/search",
  "/data",
  "/data/speed-chart",
  "/data/top-builds",
  "/speed-chart",
  "/damage-calc",
  "/box",
  "/box/__perf_warmup__",
  "/box/__perf_warmup__?tab=damage",
  "/box/data?pokemon=__perf_warmup__",
  "/box/matchup?pokemon=__perf_warmup__",
  "/box/ranked?pokemon=__perf_warmup__",
  "/team",
  "/team/new",
  "/team/__perf_warmup__",
  "/ranked-teams",
  "/share/__perf_warmup__",
] as const;

export default async function warmPerfRoutes(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("performance test の baseURL が設定されていません。");

  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    for (const route of PERF_WARMUP_ROUTES) {
      await page.goto(new URL(route, baseURL).toString(), { waitUntil: "load", timeout: 60_000 });
    }
  } finally {
    await browser.close();
  }
}
