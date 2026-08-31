/**
 * `tests/perf/scenarios/*.perf.spec.ts` が積んだ type: "perf" annotation を集計し、
 * - docs/perf/results/latest.json (最新の生データ)
 * - docs/perf/results/<timestamp>.json (履歴)
 * - docs/perf/dashboard.md の PERF_TABLE_START〜END の間 (一覧表)
 * を書き出すPlaywrightカスタムレポーター。playwright.perf.config.ts から読み込まれる。
 *
 * dashboard.md はマーカー間だけを機械的に置き換えるので、マーカーの外側
 * (計測方針の説明文など)は手で自由に書き足してよい。
 */
import type { Reporter, TestCase, TestResult, FullResult } from "@playwright/test/reporter";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const RESULTS_DIR = path.join(REPO_ROOT, "docs/perf/results");
const DASHBOARD_PATH = path.join(REPO_ROOT, "docs/perf/dashboard.md");
const TABLE_START = "<!-- PERF_TABLE_START -->";
const TABLE_END = "<!-- PERF_TABLE_END -->";

interface PerfRecord {
  id: string;
  label: string;
  category: string;
  targetMs: number;
  note?: string;
  ms: number;
  measuredAt: string;
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function priorityOf(ratio: number): string {
  if (ratio >= 1.5) return "🔴 要対応";
  if (ratio >= 1.0) return "🟡 注意";
  return "🟢 達成";
}

export default class PerfReporter implements Reporter {
  private records: PerfRecord[] = [];

  onTestEnd(_test: TestCase, result: TestResult): void {
    for (const annotation of result.annotations) {
      if (annotation.type !== "perf" || !annotation.description) continue;
      this.records.push(JSON.parse(annotation.description) as PerfRecord);
    }
  }

  onEnd(_result: FullResult): void {
    if (this.records.length === 0) {
      console.warn("[perf-reporter] perf annotationが1件もありません。dashboard.mdは更新しません。");
      return;
    }

    mkdirSync(RESULTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(path.join(RESULTS_DIR, `${stamp}.json`), JSON.stringify(this.records, null, 2));
    writeFileSync(path.join(RESULTS_DIR, "latest.json"), JSON.stringify(this.records, null, 2));

    const byId = new Map<string, PerfRecord[]>();
    for (const r of this.records) {
      const list = byId.get(r.id) ?? [];
      list.push(r);
      byId.set(r.id, list);
    }

    const rows = [...byId.entries()]
      .map(([id, recs]) => {
        const { label, category, targetMs, note } = recs[0];
        const actualMs = Math.round(median(recs.map((r) => r.ms)));
        const ratio = actualMs / targetMs;
        return { id, label, category, targetMs, actualMs, ratio, note: note ?? "" };
      })
      .sort((a, b) => b.ratio - a.ratio);

    const header =
      "| 優先度 | 分類 | 画面/操作 | 目標(ms) | 実測(ms, 中央値) | 超過率 | 備考 |\n|---|---|---|---|---|---|---|";
    const body = rows
      .map(
        (r) =>
          `| ${priorityOf(r.ratio)} | ${r.category} | ${r.label} | ${r.targetMs} | ${r.actualMs} | ${r.ratio.toFixed(2)}x | ${r.note} |`,
      )
      .join("\n");
    const generatedAt = `_最終計測: ${new Date().toISOString()} (${rows.length}シナリオ, 計${this.records.length}試行の中央値。タイムアウト等で一部シナリオは試行回数が少ない場合がある)_`;
    const table = `${TABLE_START}\n${header}\n${body}\n\n${generatedAt}\n${TABLE_END}`;

    const existing = existsSync(DASHBOARD_PATH)
      ? readFileSync(DASHBOARD_PATH, "utf-8")
      : `# パフォーマンス計測ダッシュボード\n\n${TABLE_START}\n${TABLE_END}\n`;
    const updated = existing.includes(TABLE_START)
      ? existing.replace(new RegExp(`${TABLE_START}[\\s\\S]*${TABLE_END}`), table)
      : `${existing}\n\n${table}\n`;
    writeFileSync(DASHBOARD_PATH, updated);
  }
}
