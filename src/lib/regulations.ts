// レギュレーション(owned_pokemon.regulation / teams.regulation)に関する唯一の情報源。
//
// レギュレーション一覧は jpoke の `jpoke.types.Regulation`(Literal)から機械的に生成した
// public/master-data/autocomplete/regulations.json をビルド時に静的importして読む
// (src/lib/pyodide-engine.ts が public/master-data/pyodide/wheel-manifest.json を
// 静的importしているのと同じ方式。生成は scripts/build-master-data/extract_autocomplete.py の
// build_regulations、`npm run build:master-data`)。
// アプリ側でレギュレーション名をハードコードしないこと ── jpoke に新しいレギュレーションが
// 増えたら build:master-data を回すだけで全画面の選択ボックスに反映される、という関係を保つ。
//
// 2026-08-01 時点の jpoke が定義するのは "M-A" / "M-B" の2つ(ポケモンチャンピオンズの
// レギュレーション)。下の isTerastalRegulation が判定する "T-<n>" 系は現時点では存在しない。
import regulationsMasterData from '../../public/master-data/autocomplete/regulations.json';

export const REGULATIONS: readonly string[] = (regulationsMasterData as Array<{ name: string }>).map((r) => r.name);

// 選択ボックスに並べる順(新しいレギュレーションが上)。
// UI改修依頼(2026-08-01)「レギュレーションの選択肢は新しい順に並べる」対応。
//
// ⚠ REGULATIONS 自体は並べ替えない。jpoke の Literal 定義順(= 古い順)であることに依存している
// 箇所があるため ── 具体的には src/lib/speed-chart-validation.ts の
// resolveSpeedChartRegulation() が「REGULATIONS の末尾 = 最新」として既定値を決めている。
// 表示順だけを変えたいので、逆順の別配列を新設して選択ボックス側だけがこちらを使う。
// (REGULATIONS を破壊的に reverse() すると元配列まで変わるので、コピーしてから反転する)
export const REGULATIONS_NEWEST_FIRST: readonly string[] = [...REGULATIONS].reverse();

// 選択ボックスの placeholder。「レギュレーションなし(未指定)」を選ぶための空 option の
// ラベルであり、値は空文字("")=DB上は NULL。UI改修依頼(2026-08-01)の
// 「なし、を指定するために placeholder "レギュレーション" のままを許容する」に対応する。
export const REGULATION_PLACEHOLDER = 'レギュレーション';

export function isKnownRegulation(value: unknown): value is string {
  return typeof value === 'string' && REGULATIONS.includes(value);
}

// 空文字・空白・未知の値はすべて「未指定」(null)に倒す。
// 未知の値を null に落とすのは、jpoke からレギュレーションが削除された場合に、
// 古い値が選択ボックスに存在しない状態のまま保存され続けるのを避けるため。
export function normalizeRegulation(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return isKnownRegulation(trimmed) ? trimmed : null;
}

// テラスタルが存在するレギュレーションかどうか。
//
// UI改修依頼(2026-08-01)「レギュレーション "T-<n>" のときだけテラスタル選択ボックスを表示」+
// ユーザー確認(同日)「レギュレーション未指定のときは従来どおり表示、M-* のときだけ非表示」。
// ポケモンチャンピオンズ(M-*)にテラスタルは存在しない(vendor/jpoke の
// ranked_team_members.tera_type が全件NULLである理由もこれ。migrations/010_ranked_teams.sql参照)
// ため、M-* を選んだときだけテラス欄を隠す。未指定(null)は「まだ決めていない」であって
// 「テラスタル無しのルール」ではないので、既存個体の編集を壊さないよう表示側に倒す。
export function isTerastalRegulation(regulation: string | null | undefined): boolean {
  if (regulation == null || regulation === '') return true; // 未指定 = 従来どおり表示
  return regulation.startsWith('T-');
}
