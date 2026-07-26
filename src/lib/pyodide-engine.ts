/**
 * Pyodide + jpoke によるブラウザ内ダメージ計算エンジン。
 *
 * **クライアント専用モジュール**。Astro の SSR (フロントマター / API routes /
 * middleware.ts / worker.ts) から import しないこと。`<script>` タグ経由で
 * ブラウザにだけバンドル・実行されることを前提にしている
 * (Cloudflare Workers ランタイムには `window`/`document` が無いため、
 * サーバー側で読み込むと即座に失敗する)。
 *
 * 設計方針(開発プラン Phase 1-7):
 * - 遅延初期化: モジュールを読み込んだだけでは何も起こらない。`initEngine()` を
 *   明示的に呼んで初めて Pyodide のロードが始まる(ページ読み込み時の自動初期化はしない)。
 * - シングルトン化: 初期化 Promise をモジュールスコープに保持し、`initEngine()` を
 *   何度呼んでも実際の初期化処理(pyodide.js 読み込み・loadPyodide・wheel インストール)
 *   は1回しか走らない。2回目以降は同じ Promise を返すだけなので、同一ページ内で
 *   計算をやり直しても再初期化は発生しない。
 * - 進捗購読: `initEngine(onProgress)` の `onProgress` は複数回・複数箇所から
 *   登録可能なリスナーとして扱う。登録した瞬間に現在の状態を1回通知する
 *   (途中から購読しても現在地を把握できるようにするため)。
 *
 * - オフラインキャッシュ: `registerOfflineCache()` で `public/pyodide-sw.js` を登録すると、
 *   Pyodide CDN (`cdn.jsdelivr.net/pyodide/`) と jpoke wheel (`/master-data/pyodide/`) への
 *   GETリクエストのみが Service Worker の Cache Storage に cache-first で保存される。
 *   初回訪問時はSWのインストール完了までは通常どおりネットワークから取得するが、
 *   2回目以降のページ再読み込みでは同一オリジン内でキャッシュヒットし、再ダウンロードを回避できる。
 */

// Pyodide本体はCDNから読み込む(PoC: poc/pyodide-jpoke/index.html と同じCDN・バージョン)。
// 将来 Service Worker でオフラインキャッシュする際は、このURLをキャッシュ対象に含める。
const PYODIDE_VERSION = "v0.26.4";
const PYODIDE_CDN_BASE = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;
const PYODIDE_SCRIPT_URL = `${PYODIDE_CDN_BASE}pyodide.js`;

// build:master-data (scripts/build-master-data/build.mjs) が生成する静的アセット。
// public/ 配下はAstroが素通しで配信するため、このパスがそのままURLになる。
const JPOKE_WHEEL_URL = "/master-data/pyodide/wheels/jpoke-0.2.0-py3-none-any.whl";

// public/pyodide-sw.js: Pyodide CDN + jpoke wheel のみを対象にした cache-first Service Worker。
const SERVICE_WORKER_URL = "/pyodide-sw.js";

export type EngineStatus = "idle" | "loading" | "ready" | "error";

export interface EngineProgress {
  status: EngineStatus;
  message: string;
}

export type ProgressListener = (progress: EngineProgress) => void;

/**
 * ダメージ計算に必要な最小限のポケモン仕様。
 * 本格的なフォーム(努力値・性格などの入力UI一式)はPhase 2で作る。
 * ここではエンジンの疎通確認に必要な項目のみ扱う。
 */
export interface PokemonSpec {
  /** ポケモン名 (jpoke の日本語キー。例: "ピカチュウ") */
  name: string;
  level?: number;
  /** 性格 (例: "いじっぱり")。省略時は "まじめ" */
  nature?: string;
  gender?: "" | "male" | "female";
  abilityName?: string;
  itemName?: string;
  /** 覚えている技名一覧。省略時は calcDamages() の moveName のみを持たせる */
  moveNames?: string[];
  teraType?: string | null;
  /** 努力値 (Champions形式 0〜32) [HP, 攻撃, 防御, 特攻, 特防, 素早さ] */
  evs?: number[];
  /** 個体値 [HP, 攻撃, 防御, 特攻, 特防, 素早さ]。省略時は全て31 */
  ivs?: number[];
  /**
   * ランク補正 [HP(無視), 攻撃, 防御, 特攻, 特防, 素早さ]。各要素は -6〜+6 (範囲外はPython側でクランプする)。
   * 先頭のHP要素は evs/ivs と並びを揃えるためのプレースホルダーで、ランク補正には存在しないため無視される。
   * 省略時は全ランク0(補正なし)。
   */
  boosts?: number[];
  /**
   * 状態異常名 (例 "やけど" "どく" "もうどく" "まひ" "ねむり" "こおり" "ゆめうつつ")。
   * 省略時・空文字時は状態異常なし。タイプ免疫(ほのおタイプへの「やけど」等)で
   * 付与できない組み合わせを指定した場合は、jpoke側の通常付与判定と同様に黙って無視される。
   */
  ailment?: string;
  /**
   * テラスタルを発動させた状態で計算するか。
   * 注意: jpoke の `Pokemon` は teraType 省略時に自身の第1タイプをテラスタイプとして
   * 自動設定するため(`Pokemon.__init__` 参照)、teraType が空でも terastallized:true を
   * 指定すれば発動する(「teraType未設定なら発動しない」という誤った前提は採用していない)。
   */
  terastallized?: boolean;
}

/**
 * ダメージ計算に影響する場の状態。
 * 天候・地形に加え、壁技(ダメージそのものを軽減するサイドフィールド)のみを対象とする。
 * おいかぜ・設置技など、ダメージ計算(`Battle.calc_damages()`)自体には影響しない
 * サイドフィールドはPhase 2-1のスコープ外(育成ビルダー等、行動順や設置ダメージが
 * 絡む場面で必要になったら別途追加する)。
 */
export interface FieldSpec {
  /** 天候名 (例: "はれ" "あめ" "すなあらし" "ゆき" "おおひでり" "おおあめ" "らんきりゅう")。省略時は天候なし */
  weather?: string;
  /** 地形名 (例: "エレキフィールド" "グラスフィールド" "サイコフィールド" "ミストフィールド")。省略時は地形なし */
  terrain?: string;
  /**
   * 防御側に発動させておくサイドフィールド効果名の一覧
   * (例: ["リフレクター"], ["ひかりのかべ"], ["オーロラベール"])。
   * `Battle.calc_damages()` はダメージ軽減判定に発動有無のみを見て持続ターン数は見ないため、
   * 持続ターン数(count)は固定値で発動させれば十分。
   */
  defenderSideFields?: string[];
}

export interface CalcDamagesOptions {
  /** 乱数シード。省略時はjpoke側で毎回ランダムに決定される(結果は非決定的になる) */
  seed?: number;
  /** 急所固定で計算するか */
  critical?: boolean;
  /** 天候・地形・壁などの場の状態。省略時は素の場(天候・地形なし)で計算する */
  field?: FieldSpec;
  /** 致死率を計算する最大攻撃回数(1発〜この回数まで)。省略時は6 */
  maxLethalAttackCount?: number;
  /**
   * 連続技として同じ技を当てる回数(1〜10。範囲外はPython側でクランプする)。省略時は1。
   * `damages`(1発分の乱数16段階)には影響せず、`lethal` の各 attackCount 段階の
   * 致死率計算にのみ反映される(jpoke の `Battle.calc_lethal()` に `(技, ヒット数)` の
   * タプルとして渡すことで実現しており、「1回のダメージ乱数計算」と「連続ヒットを踏まえた
   * 致死率計算」を独立に扱えるjpoke側の設計に沿っている)。
   */
  hitCount?: number;
}

/** 攻撃をN回撃った時点での致死率(HPが0になる確率、0.0〜1.0)。 */
export interface LethalResult {
  /** 何発目か(1始まり) */
  attackCount: number;
  /** その時点までの累計致死率 */
  probability: number;
}

export interface CalcDamagesResult {
  /** 乱数16段階を考慮した、あり得るダメージ値の一覧 */
  damages: number[];
  /** 1発目〜maxLethalAttackCount発目までの致死率一覧 */
  lethal: LethalResult[];
}

/**
 * `calcLethalSequence()` で使用する、攻撃列中の1攻撃分の指定。
 *
 * `critical`〜`terrain` は今回追加したper-attack条件で、すべて省略可能。
 * 省略時は呼び出し側が渡した「カード共通の値」
 * (attackerSpec/defenderSpec の boosts/ailment/terastallized、
 * options.critical、options.field.weather/terrain/defenderSideFields)に
 * フォールバックする(優先順位: per-attack指定 > カード共通 > 未設定。詳細は
 * BOOTSTRAP_PYTHON内 `calc_lethal_sequence_json` のコメント参照)。これにより、
 * per-attack条件を一切指定しない既存の呼び出しは挙動が一切変わらない。
 * ダメージ計算の詳細設定(急所・ランク・状態異常・テラスタル・天候・地形・壁)は
 * ビルドカードではなく技カードごとに個別設定したいというUI要件に合わせたもので、
 * 攻撃ごとに乱数シードを変える要件は無いため `seed` は含めない(引き続き
 * `options.seed` がカード共通)。
 */
export interface SequenceAttack {
  /** 技名 */
  moveName: string;
  /** 連続で当てる回数(1〜10。範囲外はPython側でクランプする)。省略時は1 */
  hitCount?: number;
  /** この攻撃だけ急所固定で計算するか。省略時は options.critical にフォールバックする */
  critical?: boolean;
  /**
   * この攻撃時点での攻撃側ランク補正。省略時は attackerSpec.boosts にフォールバックする。
   * 形式は PokemonSpec.boosts と同じ([HP(無視), 攻撃, 防御, 特攻, 特防, 素早さ])。
   */
  attackerBoosts?: number[];
  /** この攻撃時点での攻撃側状態異常。省略時は attackerSpec.ailment にフォールバックする */
  attackerAilment?: string;
  /** この攻撃時点で攻撃側がテラスタル発動済みか。省略時は attackerSpec.terastallized にフォールバックする */
  attackerTerastallized?: boolean;
  /** この攻撃時点での防御側ランク補正。省略時は defenderSpec.boosts にフォールバックする */
  defenderBoosts?: number[];
  /** この攻撃時点での防御側状態異常。省略時は defenderSpec.ailment にフォールバックする */
  defenderAilment?: string;
  /** この攻撃時点で防御側がテラスタル発動済みか。省略時は defenderSpec.terastallized にフォールバックする */
  defenderTerastallized?: boolean;
  /**
   * この攻撃時点で防御側に発動している壁等のサイドフィールド効果名一覧。
   * 省略時は options.field.defenderSideFields にフォールバックする。
   */
  defenderSideFields?: string[];
  /** この攻撃時点の天候。省略時は options.field.weather にフォールバックする */
  weather?: string;
  /** この攻撃時点の地形。省略時は options.field.terrain にフォールバックする */
  terrain?: string;
}

export interface CalcLethalSequenceResult {
  /**
   * 攻撃列を先頭から1つずつ加えていったときの、各段階での累計致死率。
   * `lethal[i].attackCount` は `i + 1`(攻撃列の先頭から i+1 個目の攻撃=
   * `attacks[i]` までを、そのhitCount分の連続ヒットも含めて全て当て終えた時点)を表す。
   * 途中の段階で確率が100%(全ての乱数分岐で確実に致死)に達した場合はそこで
   * 打ち切り、それ以降の attacks は計算されない(配列は attacks より短くなり得る)。
   * 部分的な致死可能性(確率が0%より大きく100%未満)だけでは打ち切らず、
   * 生存分岐に対して後続の攻撃を計算し続ける。
   */
  lethal: LethalResult[];
  /**
   * 各攻撃(attacks[i])を単体で見た場合のダメージ値一覧(カード表示用の参考値。
   * `lethal` の打ち切りとは独立に、常に attacks と同じ件数ぶん計算される)。
   *
   * 中身は `battle.calc_lethal()` が返す `LethalHitResult.damage_counter`
   * (ダメージ値→頻度の辞書)のキーを昇順に並べたもの。**hitCountを考慮する
   * ようになった点に注意**: hitCount>1(連続技・多段技)の場合は「1発分の乱数」
   * ではなく「その攻撃1回ぶん(全ヒット合計)のダメージ」に意味が変わっている
   * (jpokeのcalc_lethalに切り替えたことで、たべのこし回復・きあいのタスキ等の
   * ターン終了時/ダメージ適用時ハンドラも反映されるようになったのに合わせた)。
   */
  perAttackDamages: number[][];
  /**
   * 各攻撃(attacks[i])を最大10回、単独で連発した場合の確定数系列
   * (「この技だけを連発したら何発で倒せるか」のカード表示用参考値)。
   * `perAttackLethal[i][k].attackCount` は `k + 1`(その技をk+1回当てた時点)。
   * 確率が100%に達した時点で打ち切る(以降のkは含まれない)。
   */
  perAttackLethal: LethalResult[][];
  /**
   * 攻撃列を先頭から実際に合成した(`lethal`と同じ範囲の)累計ダメージの
   * 厳密な最小値・最大値。各攻撃の最小同士・最大同士を単純加算した近似値ではなく、
   * `LethalHitResult.__add__` による分布合成から求めた値。
   *
   * 重要: これは「与えた打点の合計」であり、**たべのこし等の回復やどく・やけどの
   * 継続ダメージは含まない**。`__add__` が合成するのは `damage_dist`(そのヒットで
   * 与えたダメージの分布)であり、jpokeはターン終了時処理を `hp_dist` 側にしか
   * 反映しないためである(実測で確認: たべのこし持ちの相手に8発当てたとき、
   * `lethal` は明確に下がるが `cumulativeDamage` は持ち物なしと同一の264〜312になる)。
   * 回復・継続ダメージまで含んだ「実際に倒せるか」は `lethal` 側にのみ現れるので、
   * UIでこの2つを並べて出す場合は役割の違いが伝わるようにすること。
   */
  cumulativeDamage: { min: number; max: number };
}

// --- Pyodide型の最小定義(公式の型パッケージを追加導入せずに済ませるための最小限のもの) ---
interface PyProxy {
  toString(): string;
  destroy(): void;
  [key: string]: unknown;
}

interface PyodideInterface {
  loadPackage(names: string | string[]): Promise<void>;
  pyimport(name: string): { install(pkg: string): Promise<void> };
  runPythonAsync(code: string): Promise<unknown>;
  globals: { get(name: string): unknown };
  toPy(obj: unknown): PyProxy;
}

declare global {
  interface Window {
    loadPyodide?: (options?: { indexURL: string }) => Promise<PyodideInterface>;
  }
}

type CalcDamagesJsonFn = (
  attackerSpec: PyProxy,
  defenderSpec: PyProxy,
  moveName: string,
  seed: number | null,
  critical: boolean,
  fieldSpec: PyProxy,
  maxLethalAttackCount: number,
  hitCount: number,
) => string;

type CalcStatsJsonFn = (spec: PyProxy) => string;

type CalcLethalSequenceJsonFn = (
  attackerSpec: PyProxy,
  defenderSpec: PyProxy,
  attacks: PyProxy,
  seed: number | null,
  critical: boolean,
  fieldSpec: PyProxy,
) => string;

// --- モジュールスコープの状態(シングルトン) ---
let pyodideSingleton: PyodideInterface | null = null;
let calcDamagesJsonFn: CalcDamagesJsonFn | null = null;
let calcStatsJsonFn: CalcStatsJsonFn | null = null;
let calcLethalSequenceJsonFn: CalcLethalSequenceJsonFn | null = null;
let initPromise: Promise<PyodideInterface> | null = null;
let currentStatus: EngineStatus = "idle";
let currentMessage = "未初期化";
const listeners = new Set<ProgressListener>();

function notify(status: EngineStatus, message: string): void {
  currentStatus = status;
  currentMessage = message;
  for (const listener of listeners) {
    listener({ status, message });
  }
}

/** 現在の初期化状態を購読なしで取得したい場合用。 */
export function getEngineProgress(): EngineProgress {
  return { status: currentStatus, message: currentMessage };
}

/**
 * Pyodideコア一式・jpoke wheel のオフラインキャッシュ用 Service Worker を登録する。
 *
 * `initEngine()` とは独立した処理で、Pyodide自体のロードは一切開始しない
 * (ページ読み込み時に呼んでも遅延初期化方針に反しない)。ブラウザが
 * Service Worker 未対応の場合は何もしない。登録は一度で十分なため、
 * ページ読み込みごとに呼んでも `register()` が冪等に処理する。
 */
export function registerOfflineCache(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }
  navigator.serviceWorker.register(SERVICE_WORKER_URL).catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.warn("Service Workerの登録に失敗しました:", err);
  });
}

function loadScriptOnce(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      if (window.loadPyodide) {
        // 既に読み込み完了済み。
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () =>
        reject(new Error(`スクリプトの読み込みに失敗しました: ${src}`)),
      );
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () =>
      reject(new Error(`スクリプトの読み込みに失敗しました: ${src}`)),
    );
    document.head.appendChild(script);
  });
}

/**
 * jpoke のインポートとダメージ計算ヘルパーを定義する固定Pythonコード。
 *
 * 重要: この文字列はビルド時に確定した固定コードであり、ユーザー入力を
 * 文字列結合することは絶対にしない。実際の計算対象(ポケモン名・技名・
 * 努力値など、すべてユーザー由来の値になり得るデータ)は、この関数定義後に
 * `calc_damages_json()` の**引数**として `pyodide.toPy()` 経由のPythonオブジェクト
 * で渡す。これによりコードインジェクションの経路を断つ。
 *
 * 重要: この文字列はJSのテンプレートリテラルなので、**中でバッククォートを使ってはいけない**
 * (Pythonのdocstring内であっても文字列がそこで終端し、以降のPythonコードがTypeScriptとして
 * パースされて `[PARSE_ERROR] Expected a semicolon ...` でビルドが落ちる)。
 * Python側のコメントで識別子を引用したいときはシングルクォートか「」を使うこと。
 * 同じ理由で `${'$'}{...}` の形も書かないこと(意図しない式展開になる)。
 */
const BOOTSTRAP_PYTHON = `
import json
from jpoke import Battle, Player, Pokemon, Move
from jpoke.core import EventContext
from jpoke.enums import Event
from jpoke.utils.constants import STATS, STAT_RANK_MIN, STAT_RANK_MAX
from jpoke.utils.lethal_dist import State, add_dist


def _clamp_boost(value):
    # 範囲外のランク値はここ(Python側)でクランプする。
    try:
        value = int(value)
    except (TypeError, ValueError):
        return 0
    return max(STAT_RANK_MIN, min(STAT_RANK_MAX, value))


def _clamp_hit_count(value):
    # 範囲外の連続ヒット回数はここ(Python側)でクランプする。省略(None)時は1。
    try:
        value = int(value)
    except (TypeError, ValueError):
        return 1
    return max(1, min(10, value))


def _build_pokemon(spec, fallback_move_name):
    """PokemonSpec(JS由来のdict)からPokemonを組み立てる、3関数共通のヘルパー。

    ランク補正(boosts)はここで直接 pokemon.boosts[...] に反映する。boosts は
    Battle/EventManagerを介さないプレーンなdictで、ダメージ計算側も
    Pokemon.rank_modifier() 経由でこのdictを直接読むだけなので、
    Battle構築前のこの時点で設定しておけば、Battle(...)構築時に行われる
    PlayerStateへのdeepcopy(jpoke/core/player_state.py)にそのまま引き継がれる。

    一方、状態異常(ailment)とテラスタル(terastallized)はBattleのイベント機構
    (EventManagerへのハンドラ登録・Event発火)を介す必要があるため、ここでは
    扱わない。calc_damages_json/calc_lethal_sequence_jsonがBattle開始後に
    _apply_battle_only_state()で別途適用する。calc_stats_jsonはBattleを
    生成しないため、この2つは意図的に反映されない(Pokemon.statsの計算式にも
    無関係なため、反映しても計算結果は変わらない)。
    """
    move_names = spec.get("moveNames") or None
    if not move_names:
        move_names = [fallback_move_name] if fallback_move_name else ["はねる"]

    level = spec.get("level")
    pokemon = Pokemon(
        spec["name"],
        gender=spec.get("gender") or "",
        nature=spec.get("nature") or "まじめ",
        level=level if level is not None else 50,
        ability_name=spec.get("abilityName") or "",
        item_name=spec.get("itemName") or "",
        move_names=list(move_names),
        tera_type=spec.get("teraType") or None,
    )

    evs = spec.get("evs")
    if evs is not None:
        pokemon.set_evs(list(evs))
    ivs = spec.get("ivs")
    if ivs is not None:
        pokemon.set_ivs(list(ivs))

    boosts = spec.get("boosts")
    if boosts is not None:
        # STATS[1:6] == ["atk", "def", "spa", "spd", "spe"]。
        # boosts[0](HP)はevs/ivsと並びを揃えるためのプレースホルダーで無視する。
        for i, stat in enumerate(STATS[1:6], start=1):
            pokemon.boosts[stat] = _clamp_boost(boosts[i])

    return pokemon


def _apply_battle_only_state(battle, mon, spec):
    """Battle開始後、実際の対象個体(battle.actives。Battle構築時にdeepcopyされた実体)に
    対して、Battleのイベント機構を経由しないと正しく効かない状態を反映する。

    - 状態異常: Battle.set_ailment()はAilmentManager.apply()を呼び、状態異常の
      ハンドラをEventManagerへ登録する。やけどによる物理技ダメージ半減は
      Event.ON_CALC_BURN_MODIFIER ハンドラ経由で効くため、Ailment()の直接代入では
      効かない(タイプ免疫などにより付与できない場合は戻り値Falseで黙って無視される。
      実機のどく/やけど等の通常付与判定と同じ挙動)。
    - テラスタル: Pokemon.terastallize()自体はis_terastallizedを立てるだけの
      薄いメソッドで、Event.ON_TERASTALLIZEを発火しない。TurnController側の実装
      (_run_terastal_phase)は terastallize() の直後にこのイベントを発火しており、
      おもかげやどし・ゼロフォーミングなど一部の特性はこのイベントで発動する。
      本関数もTurnControllerと同じ順序(terastallize() → イベント発火)を踏む。
    """
    ailment_name = spec.get("ailment")
    if ailment_name:
        battle.set_ailment(mon, ailment_name)

    if spec.get("terastallized"):
        mon.terastallize()
        battle.events.emit(Event.ON_TERASTALLIZE, EventContext(source=mon))


def _resolve_move(pokemon, move_name):
    """ポケモンの技リストからmove_nameに一致する技を探す。

    見つからない場合はmove_nameから新規にMoveを生成する(以前はactive.moves[0]に
    フォールバックしていたが、calc_lethal_sequence_jsonのように1体が複数の
    異なる技を扱う経路では、無関係な技に静かにフォールバックすると計算結果が
    誤ってしまうため、要求されたmove_nameそのものを使う形に変更した)。
    """
    for m in pokemon.moves:
        if m.name == move_name:
            return m
    return Move(move_name)


def _apply_field(battle, defender_player, field_spec):
    # count(持続ターン数)はダメージ計算(calc_damages/calc_lethal)の判定には使われず
    # 発動有無のみが見られるため、固定値5(既定の持続ターン数)で発動させれば十分。
    weather = field_spec.get("weather")
    if weather:
        battle.set_weather(weather, 5)

    terrain = field_spec.get("terrain")
    if terrain:
        battle.set_terrain(terrain, 5)

    for name in field_spec.get("defenderSideFields") or []:
        battle.activate_side_field(defender_player, name, 5)


def _group_lethal_by_attack_count(lethal_results):
    """calc_damages_json専用: calc_lethal()の結果を「1回のcalc_lethal呼び出し=1発」の粒度に整える。

    hit_count(連続ヒット回数)>1の(技, ヒット数)タプルをcalc_lethal()に渡すと、
    同じattack_countに対応する結果がhit_count件連続してから、そのターンの
    終了時処理(たべのこし等)を経た値で最後の1件が上書きされる
    (jpoke/src/jpoke/core/lethal.py _lethal_loop 参照)。呼び出し側には
    従来通りattackCountごとに1件(=そのターンの全弾終了後の値)だけを返す。

    注意: calc_damages_jsonはmovesに単一の技(または同一技のヒット数タプル)しか
    渡さないため、calc_lethal()内部のctx_listは常に1要素(1つの技のみが対象)であり、
    _lethal_loopの「HP=0の分岐が1つでも現れたら即座に打ち切る」仕様
    (jpoke/src/jpoke/core/lethal.py fainted() 参照)は「同じ技を繰り返した際の
    複数ターン分の履歴」を打ち切るだけで、この関数自体の対応範囲(結果の整形)には
    影響しない。calc_lethal_sequence_json(異なる技を順に使う攻撃列)も、攻撃1件
    ごとにその技専用のBattle上でcalc_lethal()をmax_attack=1で個別に呼ぶ構成に
    しているため(ctx_listはやはり常に1要素)、同じ理由でこの打ち切り仕様の影響を
    受けない。攻撃をまたぐ累計はcalc_lethal_sequence_json側でLethalHitResultを
    '__add__'で合成して求めており、本関数(_group_lethal_by_attack_count)とは
    別の仕組みなので混同しないこと。
    """
    lethal = []
    for result in lethal_results:
        entry = {"attackCount": result.attack_count, "probability": result.lethal_probability}
        if lethal and lethal[-1]["attackCount"] == result.attack_count:
            lethal[-1] = entry
        else:
            lethal.append(entry)
    return lethal


def calc_damages_json(
    attacker_spec, defender_spec, move_name, seed, critical, field_spec,
    max_lethal_attack_count, hit_count,
):
    player1 = Player("Attacker")
    attacker = _build_pokemon(attacker_spec, move_name)
    player1.team.append(attacker)

    player2 = Player("Defender")
    defender = _build_pokemon(defender_spec, None)
    player2.team.append(defender)

    battle = Battle(player1, player2, seed=seed)
    battle.start()
    _apply_field(battle, player2, field_spec)

    active_attacker, active_defender = battle.actives
    _apply_battle_only_state(battle, active_attacker, attacker_spec)
    _apply_battle_only_state(battle, active_defender, defender_spec)

    move = _resolve_move(active_attacker, move_name)
    damages = battle.calc_damages(active_attacker, active_defender, move, critical=critical)

    n_hits = _clamp_hit_count(hit_count)
    move_arg = move if n_hits <= 1 else (move, n_hits)
    lethal_results = battle.calc_lethal(
        active_attacker, move_arg, critical=critical, max_attack=max_lethal_attack_count
    )
    lethal = _group_lethal_by_attack_count(lethal_results)

    return json.dumps({"damages": damages, "lethal": lethal})


def calc_stats_json(spec):
    # fallback_move_name=None: 育成ビルダーでは技を1つも選んでいない状態でも実数値計算が
    # 必要なため、_build_pokemon() 側の「moveNamesが空ならfallback_move_nameを使い、
    # それも無ければ["はねる"]で補う」フォールバックにそのまま委ねる
    # (spec.moveNamesが空リストでもエラーにならない)。
    pokemon = _build_pokemon(spec, None)
    return json.dumps({"stats": pokemon.stats})


def _clamp_hp_dist_min0(hp_dist):
    """hp_distの各枝のHP値を0未満にならないようクランプする(戻り値は新しいdict)。

    'jpoke.core.lethal.LethalHitResult.__add__'内部の'subtract_dist'呼び出しは
    minimumを指定していない(クランプなし)。そのため、既にHP=0(致死済み)の枝を
    含む結果に対してさらに'__add__'で後続の攻撃を合成すると、その枝のHPが
    負の値になり得る。'lethal_probability'は'state.value == 0'の頻度でしか
    致死を数えないため、負のHPは「致死していない」ものとして扱われてしまい、
    見かけ上「後続の攻撃で致死率が下がる(一度死んだはずが生き返る)」という
    非単調な不具合が生じる(実測で確認済み: 3割の乱数で7発目に部分致死した後、
    8発目を合成すると確率が0%に戻ってしまう)。本関数を合成のたびに適用し、
    「一度致死した枝は致死したまま」という単調性を保証する。
    """
    result = {}
    for state, freq in hp_dist.items():
        if state.value < 0:
            state = State(
                value=0,
                ability_enabled=state.ability_enabled,
                item_enabled=state.item_enabled,
                attacker_boosts=state.attacker_boosts,
                attacker_ailment=state.attacker_ailment,
                defender_boosts=state.defender_boosts,
                defender_ailment=state.defender_ailment,
            )
        result[state] = result.get(state, 0) + freq
    return result


def _dist_values_sorted(dist):
    """StateDist(状態→頻度)から出現するHP/ダメージ値だけを取り出し、重複を除いて
    昇順に並べた配列を返す(頻度そのものは呼び出し側では使わないため捨てる)。
    'LethalHitResult.damage_counter.keys()'と同じ集約規則(ability_enabled/
    item_enabledの違いは無視して値だけで集約する)を、単一のLethalHitResultに
    紐づかない任意のStateDist(複数ヒット分をadd_distで畳み込んだもの等)に対しても
    使えるようにした汎用版。
    """
    return sorted(set(state.value for state in dist))


def _resolve_attack_override(card_common_value, per_attack_value):
    """per-attack条件のフォールバック解決。優先順位: per-attack指定 > カード共通 > 未設定。

    per_attack_value が None(JS側でそのキー自体が省略された)場合のみ
    card_common_value にフォールバックする。False/""/空リストのような
    「値はあるがfalsyな」明示的な指定はNoneではないため、card_common_valueより
    優先してそのまま返す(空文字での状態異常クリア・空配列での壁クリア・
    False固定でのテラスタル解除/急所固定解除を、意図的な上書きとして扱うため)。
    """
    return per_attack_value if per_attack_value is not None else card_common_value


def _build_per_attack_spec(base_spec, boosts_key, ailment_key, tera_key, attack):
    """base_spec(攻撃側/防御側どちらかのカード共通PokemonSpec dict)に、attack(1攻撃分の
    dict)側のper-attackキー(boosts_key/ailment_key/tera_key。呼び出し側が
    'attackerBoosts'/'attackerAilment'/'attackerTerastallized' か
    'defenderBoosts'/'defenderAilment'/'defenderTerastallized' のいずれかを渡す)を
    マージした新しいdictを返す。base_specへの副作用を避けるためdict(base_spec)で
    浅いコピーを作ってから上書きする。
    """
    spec = dict(base_spec)
    spec["boosts"] = _resolve_attack_override(base_spec.get("boosts"), attack.get(boosts_key))
    spec["ailment"] = _resolve_attack_override(base_spec.get("ailment"), attack.get(ailment_key))
    spec["terastallized"] = _resolve_attack_override(base_spec.get("terastallized"), attack.get(tera_key))
    return spec


def calc_lethal_sequence_json(attacker_spec, defender_spec, attacks, seed, critical, field_spec):
    """攻撃列(attacks: [{"moveName": str, "hitCount": int, ...per-attack条件}, ...])を
    先頭から順に当てていったときの、各段階での累計致死率・技ごとの参考値を計算する。

    per-attack条件(優先順位: per-attack指定 > カード共通 > 未設定。'_resolve_attack_override'
    参照): 急所('critical')・攻守双方のランク補正/状態異常/テラスタル発動
    ('attacker*'/'defender*')・天候('weather')・地形('terrain')・防御側サイド
    フィールド('defenderSideFields')は、attacksの各要素で個別に上書きできる
    (詳細設定はビルドカードではなく技カードごとに持たせたいというUI要件に合わせた)。
    攻撃1件ごとに専用のBattleを作り直す本関数の構成なら、天候・地形も
    '_apply_field()'をそのBattleに対して呼ぶだけで独立させられる。
    乱数シード(seed)のみ、従来通り攻撃列全体で共通(seed引数のまま。
    技ごとに乱数系列を変える要件は無いため)。

    重要(1つのBattleを使い回さない理由): 攻撃1件ごとに専用のBattleをゼロから
    構築する。'battle.actives'のboosts直接代入・'battle.set_ailment()'・
    'mon.terastallize()'・'battle.activate_side_field()'はいずれも「設定する」
    方向にしか効かないAPIのため、1つのBattleを使い回すと「2発目でテラスタルを
    解除する」「2発目で壁を消す」といった、後続の攻撃で状態を弱める方向の変化を
    一切表現できない。Battleを作り直せば各攻撃が完全に独立した初期状態(同じ
    defender_specから組み立てた満タンHPの防御側)から計算されるため、この制約が
    まるごと消える。

    重要(2): 当初はjpokeの'Battle.calc_lethal()'に攻撃列全体を(技, ヒット数)の
    リストとしてそのまま渡し、max_attack=1で「1周だけ」実行させる実装にしていたが、
    これはバグだった。'jpoke/src/jpoke/core/lethal.py'の'_lethal_loop'は
    「HP分布の中に1つでもHP=0の分岐が現れたら、まだ生存している分岐が残っていても
    その時点で計算全体を打ち切る」仕様('fainted()'が'any()'で判定している)。
    そのため、異なる技を複数まとめて1回の'calc_lethal()'呼び出しに渡すと、
    1発目の技だけで一部の乱数が既に致死する組み合わせで2発目以降が計算されない
    ことがあった。

    しかし本関数は「攻撃1件につき、その攻撃専用のBattle上でcalc_lethalを
    max_attack=1で1回だけ呼ぶ」構成であるため、上記バグは構造的に発生し得ない
    ('_lethal_loop'の'ctx_list'は常に1要素=1つの技(のヒット数タプル)のみであり、
    「異なる技が複数まとめて渡され、どれか1つの致死でまとめて打ち切られる」状況が
    そもそも起こらない。加えて'_lethal_loop'は'results.append(result)'の**後**に
    致死判定するため、1回の呼び出しは常に1件以上の結果を返す)。

    攻撃をまたぐ累計は、各攻撃を独立に計算した'LethalHitResult'を
    'LethalHitResult.__add__'で合成することで求める('jpoke/src/jpoke/core/lethal.py'
    参照。'other.initial_hp - other.hp_dist'を「合成される側が実際に受けた
    ダメージ分布」とみなして'self.hp_dist'から差し引くため、2つの結果が別々の
    Battle上で独立に計算されていても正しく合成できる)。これにより、'calc_lethal()'
    が内部で行うターン終了時処理(たべのこし回復・どく/やけどの継続ダメージ)や
    ON_APPLY_DAMAGE系ハンドラ(がんじょう・きあいのタスキ等のHP1耐え)が、
    以前の自前HP分布積算(to_dist/subtract_dist)方式では反映されていなかったのに対し、
    本方式では正しく反映されるようになる。

    重要(3・単調性クランプ): 'LethalHitResult.__add__'が内部で呼ぶ'subtract_dist'は
    minimumを指定せずクランプしない。そのため、既にHP=0(致死済み)の枝を含む
    結果にさらに攻撃を'__add__'で合成すると、その枝のHPが負の値になり得て
    「HP=0の頻度」から外れてしまい、致死率が後続の攻撃で見かけ上下がる
    (一度死んだ枝が復活したように見える)非単調な不具合が生じる(実測で確認済み)。
    このため'_clamp_hp_dist_min0'を各合成の直後に適用し、HPを0未満にクランプする
    ことで「一度致死した枝は致死したまま」という単調性を保証している
    (perAttackLethalの自己合成・lethalの攻撃間合成の両方に適用)。

    重要(4・打点(damage)とHP(hp_dist)は別系統で扱う): 'LethalHitResult.damage_dist'は
    「そのヒット1発分」の打点分布であり、n_hits回のヒットをまたいで累積されない
    ('ctx.damage_dist'をそのまま持つだけ。'_lethal_loop'参照)。そのため
    'hit_results[-1].damage_dist'(最後のヒットのみ)や、それを合成した
    'LethalHitResult.__add__'の結果をそのまま'perAttackDamages'/'cumulativeDamage'に
    使うと、hitCount>1の技で「最後の1ヒット分」の打点しか反映されない
    (実測で確認済みのバグ: hitCountを1/2/3/5と変えても打点が変化しなかった)。
    このため打点専用に、各攻撃のn_hits全ヒット分の'damage_dist'を'add_dist'で
    畳み込んだ'attack_damage_dist'(compute_attack_result参照)を別途保持し、
    'perAttackDamages'/'cumulativeDamage'はこちらから求める。一方
    'hp_dist'/'lethal_probability'(lethal/perAttackLethal)は'LethalHitResult.__add__'
    ('other.initial_hp - other.hp_dist'によるHP合成。全ヒット+ターン終了時処理を
    正しく反映済み)のままで問題ないため変更しない。
    打点(perAttackDamages/cumulativeDamage)は「与えたダメージの単純合計」であり、
    たべのこし等の回復・どく/やけどの継続ダメージは含まない(含めると回復分だけ
    実質的なダメージが差し引かれてしまい、「確定1発で本来何%与えられるか」という
    余裕度が読めなくなるため、意図的に含めていない)。回復・継続ダメージも
    加味した「実際に倒せるか」は引き続き'lethal'/'perAttackLethal'側にのみ現れる
    (詳細は'CalcLethalSequenceResult.cumulativeDamage'のコメント参照)。

    perAttackDamages/perAttackLethalは「その攻撃を単体で見た場合」の参考値
    (カード表示用)であり、致死済み以降かどうかに関わらず常に全攻撃ぶん計算する
    (lethal/cumulativeDamageの打ち切りとは独立)。
      - perAttackDamages[i]: 攻撃iの'attack_damage_dist'(n_hits全ヒット分を
        add_distで畳み込んだ打点分布)に出現する値を、重複を除いて昇順に並べた配列
        ('_dist_values_sorted'参照)。連続技(hitCount>1)は全ヒット合計のダメージに
        意味が変わっている点に注意(1発分の乱数16段階ではない)。
      - perAttackLethal[i]: 攻撃iの結果(this_result。HP分布ベース)を最大10回、
        自分自身に'__add__'で繰り返し加算した場合の確定数系列
        (「この技だけを連発したら何発で倒れるか」)。確率100%に達したらそこで打ち切る。

    lethal/cumulativeDamageは、attacksを先頭から実際に合成した累計であり、
    途中で確率100%(全ての乱数分岐で確実に致死)に達した場合はそこで打ち切られ、
    lethalはattacksより短い配列になり得る(cumulativeDamageもその時点までの
    合成結果になる)。
    """

    def compute_attack_result(attack):
        # 攻撃1件につき、フルHPの防御側から始まる専用Battleを新規構築する
        # (このBattleは使い捨てで、次の攻撃には引き継がない)。
        move_name = attack["moveName"]
        n_hits = _clamp_hit_count(attack.get("hitCount"))
        critical_for_attack = _resolve_attack_override(critical, attack.get("critical"))

        attacker_spec_for_attack = _build_per_attack_spec(
            attacker_spec, "attackerBoosts", "attackerAilment", "attackerTerastallized", attack
        )
        defender_spec_for_attack = _build_per_attack_spec(
            defender_spec, "defenderBoosts", "defenderAilment", "defenderTerastallized", attack
        )
        # field_spec(カード共通)にattack側のper-attack上書きをマージする。
        # weather/terrain/defenderSideFieldsのいずれも、このBattle専用の
        # attack_field_specとして_apply_field()にそのまま渡すだけで独立して効く
        # (1つのBattleを使い回さないため、他の攻撃のfield_specに影響しない)。
        attack_field_spec = dict(field_spec)
        attack_field_spec["weather"] = _resolve_attack_override(field_spec.get("weather"), attack.get("weather"))
        attack_field_spec["terrain"] = _resolve_attack_override(field_spec.get("terrain"), attack.get("terrain"))
        attack_field_spec["defenderSideFields"] = _resolve_attack_override(
            field_spec.get("defenderSideFields"), attack.get("defenderSideFields")
        )

        p1 = Player("Attacker")
        att = _build_pokemon(attacker_spec_for_attack, None)
        p1.team.append(att)
        p2 = Player("Defender")
        dfd = _build_pokemon(defender_spec_for_attack, None)
        p2.team.append(dfd)

        attack_battle = Battle(p1, p2, seed=seed)
        attack_battle.start()
        _apply_field(attack_battle, p2, attack_field_spec)

        active_att, active_dfd = attack_battle.actives
        _apply_battle_only_state(attack_battle, active_att, attacker_spec_for_attack)
        _apply_battle_only_state(attack_battle, active_dfd, defender_spec_for_attack)

        move = _resolve_move(active_att, move_name)
        move_arg = move if n_hits <= 1 else (move, n_hits)
        # max_attack=1: この1回の呼び出しでこの技(のn_hitsぶんの全ヒット)だけを
        # 適用させ、ターン終了時処理まで終えた結果を得る。'hit_results'にはヒット
        # ごとに1件(n_hits件)の'LethalHitResult'が入り、最後の要素がHP分布
        # (hp_dist)としては全ヒット+ターン終了時処理まで反映済みの値になる
        # ('_lethal_loop'参照)。
        hit_results = attack_battle.calc_lethal(
            active_att, move_arg, critical=critical_for_attack, max_attack=1
        )
        if not hit_results:
            # 理論上到達しない(上記docstring「重要(2)」参照。calc_lethalは
            # 1回の呼び出しで必ず1件以上返す)が、万一の安全策としてNoneを返し、
            # 呼び出し側で「この攻撃は計算不能だった」ことが分かる形にする。
            return None, None

        # 重要: 'LethalHitResult.damage_dist'は「そのヒット1発分」の打点分布であり、
        # 累積ではない('ctx.damage_dist'をそのまま持つだけ。'_lethal_loop'参照)。
        # そのため最後の要素(hit_results[-1])だけを使うと、hitCount>1の技で
        # 「最後の1ヒット分」の打点しか取れず、n_hits倍になるはずの合計打点が
        # 1ヒット分のまま変わらないというバグになる(実測で確認済み: hitCountを
        # 1/2/3/5と変えても'perAttackDamages'が変化しなかった)。
        # 全ヒットの'damage_dist'を'add_dist'で畳み込み、「この攻撃1回ぶん
        # (n_hits全ヒット合計)」の打点分布を別途組み立てる。これは
        # 'hp_dist'/'lethal_probability'とは独立な「打点(与えたダメージの合計)」
        # 専用の値であり、hp_dist側(HPの実際の増減。回復・クランプ込み)には
        # 一切手を加えない。
        attack_damage_dist = 0
        for hr in hit_results:
            attack_damage_dist = add_dist(attack_damage_dist, hr.damage_dist)

        return hit_results[-1], attack_damage_dist

    per_attack_damages = []
    per_attack_lethal = []
    # resolvedはhp_dist/lethal/perAttackLethal用(最後のヒットのLethalHitResult)。
    # damage_dists_by_attackは打点(perAttackDamages/cumulativeDamage)専用で、
    # 各攻撃のn_hits全ヒット分をadd_distで畳み込んだ後のStateDist。
    # 両者を別々に持つのは、hp側(回復・クランプ込みの実際のHP増減)と
    # 打点側(与えたダメージの単純合計。回復等は含まない)の役割が異なるため
    # (詳細はCalcLethalSequenceResult.cumulativeDamageのコメント参照)。
    resolved = []
    damage_dists_by_attack = []
    for attack in attacks:
        this_result, attack_damage_dist = compute_attack_result(attack)
        resolved.append(this_result)
        damage_dists_by_attack.append(attack_damage_dist)

        if this_result is None:
            per_attack_damages.append([])
            per_attack_lethal.append([])
            continue

        # 全ヒット分を畳み込んだ打点分布(attack_damage_dist)のキーを昇順に並べる。
        per_attack_damages.append(_dist_values_sorted(attack_damage_dist))

        repeat_acc = this_result
        this_attack_lethal = [{"attackCount": 1, "probability": repeat_acc.lethal_probability}]
        for k in range(2, 11):
            if this_attack_lethal[-1]["probability"] >= 1.0:
                break
            repeat_acc = repeat_acc + this_result
            # 一度致死した枝が後続の合成で「生き返る」ことがないようクランプする
            # ('_clamp_hp_dist_min0'のコメント参照)。
            repeat_acc.hp_dist = _clamp_hp_dist_min0(repeat_acc.hp_dist)
            this_attack_lethal.append({"attackCount": k, "probability": repeat_acc.lethal_probability})
        per_attack_lethal.append(this_attack_lethal)

    lethal = []
    acc = None
    # cumulative_damage_distは打点(cumulativeDamage)専用の累計。accのdamage_dist
    # (最後に合成したLethalHitResultのdamage_dist)は使わない。'LethalHitResult.__add__'の
    # damage_distはヒット単位の合成であってhitCountを畳み込まないため、accから
    # 求めるとhitCount>1の攻撃が1ヒット分のまま反映されないバグになる
    # (実測で確認済み: hitCountを1/2/3/5と変えても打点側が変化しなかった)。
    # 代わりに、各攻撃ごとに既にn_hits分を畳み込み済みのdamage_dists_by_attackを
    # 'lethal'と同じ範囲(打ち切りも含めて)だけadd_distでさらに攻撃列ぶん畳み込む。
    cumulative_damage_dist = None
    for i, this_result in enumerate(resolved):
        if this_result is None:
            # 安全策発動時(理論上到達しない)は累計への合成を諦め、この攻撃だけを
            # 読み飛ばして次の攻撃から累計を継続する('lethal'の該当attackCountは
            # 欠番になるが、attacksより短い配列になり得ることは元々の仕様の範囲内)。
            continue
        if acc is not None and acc.lethal_probability >= 1.0:
            # 既に確率100%で致死が確定している(これより前の攻撃で到達した)ため、
            # 以降の攻撃は合成せずここで打ち切る。cumulative_damage_distもここで
            # 一緒に打ち切ることで、lethalと同じ範囲(打ち切られた攻撃を含まない)に揃える。
            break
        acc = this_result if acc is None else acc + this_result
        # 一度致死した枝が後続の攻撃の合成で「生き返る」ことがないようクランプする
        # ('_clamp_hp_dist_min0'のコメント参照。単調性(致死率は攻撃を重ねるごとに
        # 非減少)を保証するために必須)。
        acc.hp_dist = _clamp_hp_dist_min0(acc.hp_dist)
        lethal.append({"attackCount": i + 1, "probability": acc.lethal_probability})

        attack_damage_dist = damage_dists_by_attack[i]
        cumulative_damage_dist = (
            attack_damage_dist if cumulative_damage_dist is None
            else add_dist(cumulative_damage_dist, attack_damage_dist)
        )

    if cumulative_damage_dist is not None:
        cumulative_values = _dist_values_sorted(cumulative_damage_dist)
        cumulative_damage = {"min": cumulative_values[0], "max": cumulative_values[-1]}
    else:
        cumulative_damage = {"min": 0, "max": 0}

    return json.dumps({
        "lethal": lethal,
        "perAttackDamages": per_attack_damages,
        "perAttackLethal": per_attack_lethal,
        "cumulativeDamage": cumulative_damage,
    })
`;

/**
 * Pyodide + jpoke を初期化する(遅延初期化・シングルトン)。
 *
 * - 1回目の呼び出しでのみ実際のロード処理を開始する。
 * - 2回目以降の呼び出し(ロード中・完了後いずれも)は、新規の初期化を
 *   行わず既存の Promise をそのまま返す。
 * - `onProgress` を渡すと、以後の状態変化(loading の各段階・ready・error)を
 *   通知するリスナーとして登録される。登録直後に現在の状態を1回通知するため、
 *   初期化開始後に途中から購読しても現在地を把握できる。
 *
 * @param onProgress 進捗通知コールバック(省略可)
 */
export function initEngine(onProgress?: ProgressListener): Promise<PyodideInterface> {
  if (onProgress) {
    listeners.add(onProgress);
    onProgress({ status: currentStatus, message: currentMessage });
  }

  if (initPromise) {
    // 既に初期化が開始済み(進行中 or 完了)。再初期化はしない。
    return initPromise;
  }

  initPromise = (async (): Promise<PyodideInterface> => {
    try {
      notify("loading", "Pyodideランタイムをロード中...");
      await loadScriptOnce(PYODIDE_SCRIPT_URL);
      if (!window.loadPyodide) {
        throw new Error(
          "loadPyodideが見つかりません(pyodide.jsの読み込みに失敗した可能性があります)",
        );
      }
      const pyodide = await window.loadPyodide({ indexURL: PYODIDE_CDN_BASE });

      notify("loading", "micropipをロード中...");
      await pyodide.loadPackage("micropip");

      notify("loading", "jpoke (wheel) をインストール中...");
      const micropip = pyodide.pyimport("micropip");
      await micropip.install(JPOKE_WHEEL_URL);

      notify("loading", "jpokeの計算ヘルパーを準備中...");
      await pyodide.runPythonAsync(BOOTSTRAP_PYTHON);
      calcDamagesJsonFn = pyodide.globals.get("calc_damages_json") as CalcDamagesJsonFn;
      calcStatsJsonFn = pyodide.globals.get("calc_stats_json") as CalcStatsJsonFn;
      calcLethalSequenceJsonFn = pyodide.globals.get(
        "calc_lethal_sequence_json",
      ) as CalcLethalSequenceJsonFn;

      pyodideSingleton = pyodide;
      notify("ready", "初期化完了");
      return pyodide;
    } catch (err) {
      // 失敗時はシングルトンをリセットし、次回 initEngine() 呼び出しで再試行できるようにする。
      initPromise = null;
      pyodideSingleton = null;
      calcDamagesJsonFn = null;
      calcStatsJsonFn = null;
      calcLethalSequenceJsonFn = null;
      const message = err instanceof Error ? err.message : String(err);
      notify("error", `エラー: ${message}`);
      throw err;
    }
  })();

  return initPromise;
}

/** 初期化済み(ready状態)かどうか。 */
export function isEngineReady(): boolean {
  return currentStatus === "ready" && pyodideSingleton !== null && calcDamagesJsonFn !== null;
}

/**
 * jpoke でダメージ計算を実行する。
 *
 * `initEngine()` が完了(ready)している必要がある。文字列結合でPythonコードを
 * 組み立てるのではなく、`pyodide.toPy()` で変換したPythonオブジェクトを
 * 固定のPython関数 (`calc_damages_json`) へ引数として渡す。
 */
export async function calcDamages(
  attackerSpec: PokemonSpec,
  defenderSpec: PokemonSpec,
  moveName: string,
  options: CalcDamagesOptions = {},
): Promise<CalcDamagesResult> {
  if (!pyodideSingleton || !calcDamagesJsonFn) {
    throw new Error("エンジンが初期化されていません。先に initEngine() を呼んでください。");
  }

  const pyodide = pyodideSingleton;
  const seed = options.seed ?? null;
  const critical = options.critical ?? false;
  const maxLethalAttackCount = options.maxLethalAttackCount ?? 6;
  const hitCount = options.hitCount ?? 1;

  const attackerPy = pyodide.toPy(attackerSpec);
  const defenderPy = pyodide.toPy(defenderSpec);
  // field未指定時も空オブジェクトを渡し、Python側は毎回 dict として扱えるようにする
  // (None分岐をBOOTSTRAP_PYTHON側に増やさないための単純化)。
  const fieldPy = pyodide.toPy(options.field ?? {});
  try {
    const resultJson = calcDamagesJsonFn(
      attackerPy,
      defenderPy,
      moveName,
      seed,
      critical,
      fieldPy,
      maxLethalAttackCount,
      hitCount,
    );
    return JSON.parse(resultJson) as CalcDamagesResult;
  } finally {
    // toPy() が生成したPythonオブジェクトはJS側で明示的に破棄する
    // (Pyodideのメモリ管理規約。破棄しないとPython側の参照が残りリークする)。
    attackerPy.destroy();
    defenderPy.destroy();
    fieldPy.destroy();
  }
}

/** 実数値(HP/攻撃/防御/特攻/特防/素早さ)。jpoke の `Pokemon.stats` と同じキー。 */
export type Stats = Record<"hp" | "atk" | "def" | "spa" | "spd" | "spe", number>;

/**
 * jpoke で単体ポケモンの実数値(努力値・個体値・性格・レベルから算出される`Pokemon.stats`)を計算する。
 *
 * `initEngine()` が完了(ready)している必要がある。`calcDamages()` と同様、
 * ユーザー入力は `pyodide.toPy()` 経由で固定のPython関数 (`calc_stats_json`) へ引数として渡すのみで、
 * 文字列結合でPythonコードを組み立てることはしない。
 *
 * 育成ビルダー(Phase 3-2)では技を1つも選んでいない状態でも呼び出せる必要があるため、
 * `spec.moveNames` が未指定・空配列のいずれでもエラーにならない
 * (Python側の `_build_pokemon()` が `["はねる"]` にフォールバックする)。
 *
 * `spec.boosts` は内部的に `Pokemon.boosts` へ反映されるが、jpoke の `Pokemon.stats` は
 * ランク補正を含まない値(努力値・個体値・性格・レベルのみに基づく実数値)を返す仕様のため、
 * `boosts` を指定しても返り値の `stats` は変化しない(ランク込みの値が欲しい場合は
 * `Pokemon.ranked_stats` 相当の計算が必要だが、本関数は既存の意味を変えないため未対応)。
 * `spec.ailment`/`spec.terastallized` は、状態異常の完全な適用(やけど半減など)や
 * テラスタル発動イベントの発火にBattleのイベント機構が必要であり、単体ポケモンの
 * 実数値計算にはBattleを生成しないため、この2つは反映されない(そもそも反映しても
 * `stats` の計算式には影響しない)。
 */
export async function calcStats(spec: PokemonSpec): Promise<{ stats: Stats }> {
  if (!pyodideSingleton || !calcStatsJsonFn) {
    throw new Error("エンジンが初期化されていません。先に initEngine() を呼んでください。");
  }

  const pyodide = pyodideSingleton;
  const specPy = pyodide.toPy(spec);
  try {
    const resultJson = calcStatsJsonFn(specPy);
    return JSON.parse(resultJson) as { stats: Stats };
  } finally {
    specPy.destroy();
  }
}

/**
 * jpoke で、複数の技を順番に当てていったときの累計致死率(加算ダメージ計算)を求める。
 *
 * `initEngine()` が完了(ready)している必要がある。`calcDamages()`/`calcStats()` と同様、
 * ユーザー入力は `pyodide.toPy()` 経由で固定のPython関数 (`calc_lethal_sequence_json`) へ
 * 引数として渡すのみで、文字列結合でPythonコードを組み立てることはしない。
 *
 * 天候・地形・急所・ランク補正・状態異常・テラスタル・壁は、`attacks` の各要素
 * (`SequenceAttack`)で個別に上書きできる(省略時は `attackerSpec`/`defenderSpec`/
 * `options` に渡した「カード共通の値」にフォールバックする。優先順位・詳細は
 * `SequenceAttack` のコメントおよび Python ブートストラップ側
 * (`pyodide-engine.ts` の `BOOTSTRAP_PYTHON` 内 `calc_lethal_sequence_json`)の
 * コメント参照)。攻撃1件ごとに専用の Battle を新規構築するため、例えば
 * 「1発目だけテラスタル発動」「2発目で壁を消す」といった、1つの Battle を
 * 使い回していた旧実装では表現できなかった条件も指定できる。
 * `options.seed`(乱数シード)のみ、技ごとに変える要件が無いため引き続き
 * 攻撃列全体で共通。
 *
 * 攻撃列の途中で確率100%(全ての乱数分岐で確実に致死)に達した場合はそこで
 * 打ち切られ、`lethal`/`cumulativeDamage` は `attacks` より短い範囲になり得る
 * (`perAttackDamages`/`perAttackLethal` は打ち切りと独立に常に全攻撃ぶん計算される)。
 * jpoke の `Battle.calc_lethal()` を経由するようになったため、たべのこし回復・
 * どく/やけどの継続ダメージ・がんじょう/きあいのタスキ等のターン終了時/
 * ダメージ適用時ハンドラも反映される(旧実装の自前HP分布積算方式では
 * 未対応だった制約はこの変更で解消した)。
 */
export async function calcLethalSequence(
  attackerSpec: PokemonSpec,
  defenderSpec: PokemonSpec,
  attacks: SequenceAttack[],
  options: CalcDamagesOptions = {},
): Promise<CalcLethalSequenceResult> {
  if (!pyodideSingleton || !calcLethalSequenceJsonFn) {
    throw new Error("エンジンが初期化されていません。先に initEngine() を呼んでください。");
  }

  const pyodide = pyodideSingleton;
  const seed = options.seed ?? null;
  const critical = options.critical ?? false;

  const attackerPy = pyodide.toPy(attackerSpec);
  const defenderPy = pyodide.toPy(defenderSpec);
  const attacksPy = pyodide.toPy(attacks);
  // field未指定時も空オブジェクトを渡し、Python側は毎回 dict として扱えるようにする
  // (calcDamages() と同様の単純化)。
  const fieldPy = pyodide.toPy(options.field ?? {});
  try {
    const resultJson = calcLethalSequenceJsonFn(
      attackerPy,
      defenderPy,
      attacksPy,
      seed,
      critical,
      fieldPy,
    );
    return JSON.parse(resultJson) as CalcLethalSequenceResult;
  } finally {
    attackerPy.destroy();
    defenderPy.destroy();
    attacksPy.destroy();
    fieldPy.destroy();
  }
}
