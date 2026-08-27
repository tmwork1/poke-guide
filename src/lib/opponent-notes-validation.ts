// /api/opponent-notes・/api/opponent-notes/:id のリクエストボディ検証ロジック。
// Astro/Cloudflare ランタイムに依存しない純粋な関数として切り出し、node --test で
// ユニットテストできるようにする(src/lib/owned-pokemon-validation.ts と同じ方針)。
//
// opponent_build/field は src/lib/pyodide-engine.ts の PokemonSpec/FieldSpec 形状に対応する
// キーのみを許容する(育成データ管理計画.md §8 Phase D-1)。ここでの検証はあくまで型・形式の
// チェックであり、「他人のデータへ書き込ませない」ホワイトリスト方式の匿名化そのものは
// src/lib/opponent-note-anonymize.ts が別途、独立して保証する(このファイルの検証を素通りしても
// 匿名化側は自前で許可フィールドのみコピーする)。

import { isMoveNamesArray, isPlainObject, isStatArray, isStringArray, STAT_COUNT } from './validation-primitives.ts';

export interface OpponentBuildInput {
  name: string;
  level?: number;
  nature?: string;
  gender?: '' | 'male' | 'female';
  abilityName?: string;
  itemName?: string;
  moveNames?: string[];
  teraType?: string | null;
  evs?: number[];
  ivs?: number[];
}

// 攻撃列(1枚のカードで相手に順番に当てる複数の攻撃)の1件分。
// hitCount は連続回数(2回攻撃・多段技等)で、省略時は1回として扱う。
//
// critical〜terrain は、ダメージ計算の詳細設定(急所・ランク・状態異常・テラスタル・
// 天候・地形・壁)をビルドカードではなく技カードごとに個別設定したいというUI要件に
// 対応する追加キーで、すべて任意項目。省略時はカード共通の値(OpponentFieldInputの
// attackerBoosts/attackerAilment/attackerTerastallized・defenderBoosts/
// defenderAilment/defenderTerastallized・weather/terrain・defenderSideFields、
// および field.critical)にフォールバックする(優先順位・実際のフォールバック処理は
// src/lib/pyodide-engine.ts の calcLethalSequence()/BOOTSTRAP_PYTHON側が担う。
// このファイルはあくまで保存前の形式検証のみを行う)。
export interface OpponentAttackInput {
  moveName: string;
  hitCount?: number;
  critical?: boolean;
  stealthRock?: boolean;
  defenderDisguiseBroken?: boolean;
  spikes?: number;
  attackerBoosts?: number[];
  attackerAilment?: string;
  attackerTerastallized?: boolean;
  // attackerTeraType/defenderTeraType: 自分側の技カードごとに、育成タブで確定した本来の
  // テラスタイプとは別の仮想テラスタイプを試せるようにするための上書き値。相手側は
  // row.teraTypeを技ごとにON/OFFするだけで足りるが、自分側は本来のテラスタイプが
  // #tera/DBのtera_typeで別途固定されているため、技カードごとの独立した上書きが必要。
  // 空文字列は「上書きなし(本来のテラスタイプを使う)」を意味する。opponent_build.teraTypeと
  // 同様、19タイプのホワイトリストは作らず「文字列であること」のみを検証する。
  attackerTeraType?: string;
  // 揮発性状態名の一覧(例 "じゅうでん")。src/lib/pyodide-engine.ts の
  // PokemonSpec.volatiles/SequenceAttack.attackerVolatiles/defenderVolatiles に対応する
  // 追加キー。状態異常名(attackerAilment/defenderAilment)と同様、
  // 許容リストはjpoke側の定義が正であり、ここでは二重管理のホワイトリストを作らず
  // 「文字列配列であること」のみを検証する。
  attackerVolatiles?: string[];
  defenderBoosts?: number[];
  defenderAilment?: string;
  defenderTerastallized?: boolean;
  defenderTeraType?: string;
  defenderVolatiles?: string[];
  defenderSideFields?: string[];
  weather?: string;
  terrain?: string;
}

export interface OpponentFieldInput {
  weather?: string;
  terrain?: string;
  defenderSideFields?: string[];
  // damage_calcs.field 相当のFieldSpecキーに加えて、Pyodideエンジンの計算オプション
  // (calcDamages() の seed/critical)も対戦相手メモの入力としてはここに含めて保存する
  // (計画書の指示: 「field(オブジェクト、FieldSpec相当のキー+任意でseed・critical)」)。
  seed?: number;
  critical?: boolean;
  // ##### 連結カード(1体の相手+複数攻撃の加算ダメージ計算)対応の追加キー #####
  // 場の状態・ランク補正・状態異常・テラスタル発動・急所は計算エンジンが単一のバトル状態で
  // 動く都合上、攻撃列全体で共通の値として持つ(攻撃ごとに変わるのは attacks の中身のみ)。
  //
  // 攻撃側(この所持ポケモン)・防御側(相手)のランク補正。[HP(無視), 攻撃, 防御, 特攻, 特防, 素早さ]
  // の6要素、各要素は -6〜+6 の整数(opponent_build.evs/ivs と同じ「固定長の数値配列」の流儀)。
  attackerBoosts?: number[];
  // 状態異常名。許容リスト(のどんな文字列が有効か)はjpoke側の定義が正であり、ここで二重管理の
  // ホワイトリストは作らない(状態異常名が増減してもこのファイルを追随修正する必要がないようにする)。
  // そのため検証は「文字列であること」のみに留める。
  attackerAilment?: string;
  attackerTerastallized?: boolean;
  // attackerTeraType/defenderTeraType: 自分側の技カードごとに、育成タブで確定した本来の
  // テラスタイプとは別の仮想テラスタイプを試せるようにするための上書き値(カード共通の
  // 既定値。技カードごとの上書きは OpponentAttackInput.attackerTeraType/defenderTeraType)。
  // 空文字列は「上書きなし(本来のテラスタイプを使う)」を意味する。
  attackerTeraType?: string;
  defenderBoosts?: number[];
  defenderAilment?: string;
  defenderTerastallized?: boolean;
  defenderTeraType?: string;
  // 攻撃列。未指定/空配列の場合は move_name による従来の「単発メモ」として扱う(既存データ互換)。
  attacks?: OpponentAttackInput[];
  // ##### 攻守の向き(個体編集画面のダメージ計算カードの「攻守切り替えボタン」用) #####
  // attackerBoosts/attackerAilment/attackerTerastallized・defenderBoosts/defenderAilment/
  // defenderTerastallized(および attacks)は、あくまで「攻撃側/防御側」という役割に対する値であり、
  // attacker/defender という名前が指すポケモンがどちらなのかは固定ではない。direction が
  // それを切り替えるフラグである。
  //   - 'attack'(既定・未指定時と同じ解釈。既存データ互換): この所持ポケモンが攻撃側 = attacker*、
  //     相手が防御側 = defender*。
  //   - 'defense': 相手が攻撃側 = attacker*、この所持ポケモンが防御側 = defender*。
  // つまり「attacker は常に所持ポケモン」ではない点に注意すること(将来この意味を誤解しないため、
  // ここに明記する)。省略時は既存データ互換のため 'attack' 相当として扱う。
  direction?: 'attack' | 'defense';
  // ##### カードの並び順(ダメージ計算カード) #####
  // opponent_notes テーブルには並び順を保持するカラムが存在しない(created_at DESCで
  // 一覧取得している)ため、この field(jsonb)に分数キー方式(fractional indexing)で
  // 並び順を持たせる。値が小さいほど先頭に近い。小数を許容する(挿入のたびに前後の値の
  // 中間を取るため)ので Number.isInteger は使わず Number.isFinite で検証する。未指定の
  // 既存データは並び順情報を持たないため、クライアント側でサーバー返却順(created_at DESC)を
  // フォールバックとして使う。
  order?: number;
}

// client_result jsonb はUI側の計算結果のスナップショットであり、サーバは再計算しない。
// 単発メモと攻撃列の両方を許容するため、フィールドは全て任意にしている。
export interface OpponentClientResultInput {
  defenderHp: number;
  // 攻撃列の各攻撃を単体で見た場合のダメージ値一覧(perAttackDamages[攻撃のインデックス][...])。
  // calcLethalSequence()の返り値と同じ形(pyodide-engine.tsのCalcLethalSequenceResult参照)。
  perAttackDamages?: number[][];
  // 攻撃列を先頭から順に加えたときの累計致死率。
  lethal?: Array<{ attackCount: number; probability: number }>;
  // 各攻撃を単独で最大10回繰り返した場合の確定数系列
  // (perAttackLethal[攻撃のインデックス][発数-1])。ページ再読み込み直後
  // (Pyodide初期化前)にも計算結果スナップショットを即座に表示できるよう、
  // UI側の計算結果をそのまま保存する(サーバ側での再計算はしない)。
  perAttackLethal?: Array<Array<{ attackCount: number; probability: number }>>;
  // 加算後(攻撃列を先頭から順に当てた)ダメージの厳密な最小/最大
  // (LethalHitResult.__add__による分布合成の結果。各攻撃の最小/最大の単純合計ではない)。
  cumulativeDamage?: { min: number; max: number };
  // 単発メモでは、単一の技の1発あたりダメージ乱数16段階を保持する。
  damages?: number[];
}

export interface OpponentNoteRequestBody {
  // 作成時は必須(呼び出し元が requireOwnedPokemonId: true で検証を要求する)。
  // 更新時は指定不要(紐づく個体の付け替えは許可しない)。
  owned_pokemon_id: string | null;
  opponent_build: OpponentBuildInput;
  field: OpponentFieldInput;
  move_name: string | null;
  // サーバは「JSONオブジェクトであること」程度の緩い検証しかしない(過剰に厳しくしない方針)ため、
  // 型としては OpponentClientResultInput(想定形状)を許容しつつ、実行時にはそれ以外の
  // Record<string, unknown> もそのまま素通りする。
  client_result: OpponentClientResultInput | Record<string, unknown> | null;
  memo: string | null;
}

export interface ValidateOpponentNoteOptions {
  // POST(新規作成)では true にして owned_pokemon_id を必須にする。
  // PUT(更新)では false にして owned_pokemon_id を受け付けない(未指定として無視する)。
  requireOwnedPokemonId: boolean;
}

export type OpponentNoteValidationResult =
  | { ok: true; value: OpponentNoteRequestBody }
  | { ok: false; error: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_LEVEL = 1;
const MAX_LEVEL = 100;
const VALID_GENDERS = new Set(['', 'male', 'female']);
// 攻守の向き(direction)。'attack' = この所持ポケモンが攻撃側(既定)、'defense' = 相手が攻撃側。
const VALID_DIRECTIONS = new Set(['attack', 'defense']);
// ランク補正(boosts)は -6〜+6 の整数(ポケモンの能力ランク補正の仕様上限)。
const BOOST_MIN = -6;
const BOOST_MAX = 6;
// 攻撃列(attacks)の1件あたりの連続回数(2回攻撃・3〜5回攻撃技等)の範囲。
const MIN_HIT_COUNT = 1;
const MAX_HIT_COUNT = 10;
// 連結カードのUI上の現実的な上限として、1枚のカードに含められる攻撃の件数を6件までとする。
const MAX_ATTACK_COUNT = 6;

const OPPONENT_BUILD_KEYS = new Set([
  'name',
  'level',
  'nature',
  'gender',
  'abilityName',
  'itemName',
  'moveNames',
  'teraType',
  'evs',
  'ivs',
]);

const OPPONENT_FIELD_KEYS = new Set([
  'weather',
  'terrain',
  'defenderSideFields',
  'seed',
  'critical',
  'attackerBoosts',
  'attackerAilment',
  'attackerTerastallized',
  'attackerTeraType',
  'defenderBoosts',
  'defenderAilment',
  'defenderTerastallized',
  'defenderTeraType',
  'attacks',
  'direction',
  'order',
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// ランク補正配列(attackerBoosts/defenderBoosts)を検証する。isStatArray(evs/ivs用)と同じ
// 「固定長6・整数・範囲チェック」の流儀だが、負の値(-6)も許容する点のみ異なる。
function isBoostArray(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length !== STAT_COUNT) return false;
  return value.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= BOOST_MIN && v <= BOOST_MAX);
}

// 攻撃列(attacks)を検証する。各要素は { moveName: 非空文字列, hitCount?: 1〜10の整数,
// ...per-attack条件(すべて任意) } の形。
//
// 注意(既存の流儀): この関数は「認識している既知キーの型・範囲」のみを検証し、
// isAttacksArray自体はopponent_build/fieldのような「未知キーを含んだら拒否」という
// 全体チェックを行わない(そのようなロジックは以前から無かった)。実際に未知キーが
// 混ざった場合、下流の正規化処理(validateOpponentField内のattacks.map())が
// 既知キーだけを明示的にコピーするため、未知キーは検証をすり抜けた上で
// サイレントに読み捨てられる(エラーにはならない)。これは新規追加したper-attack
// キーでも変えておらず、既存の挙動をそのまま踏襲している。
function isAttacksArray(value: unknown): value is OpponentAttackInput[] {
  if (!Array.isArray(value) || value.length > MAX_ATTACK_COUNT) return false;
  return value.every((v) => {
    if (!isPlainObject(v)) return false;
    if (!isNonEmptyString(v.moveName)) return false;
    if (v.hitCount !== undefined) {
      if (typeof v.hitCount !== 'number' || !Number.isInteger(v.hitCount)) return false;
      if (v.hitCount < MIN_HIT_COUNT || v.hitCount > MAX_HIT_COUNT) return false;
    }
    if (v.critical !== undefined && typeof v.critical !== 'boolean') return false;
    if (v.stealthRock !== undefined && typeof v.stealthRock !== 'boolean') return false;
    if (v.defenderDisguiseBroken !== undefined && typeof v.defenderDisguiseBroken !== 'boolean') return false;
    if (v.spikes !== undefined) {
      if (typeof v.spikes !== 'number' || !Number.isInteger(v.spikes)) return false;
      if (v.spikes < 0 || v.spikes > 3) return false;
    }
    if (v.attackerBoosts !== undefined && !isBoostArray(v.attackerBoosts)) return false;
    if (v.attackerAilment !== undefined && typeof v.attackerAilment !== 'string') return false;
    if (v.attackerTerastallized !== undefined && typeof v.attackerTerastallized !== 'boolean') return false;
    if (v.attackerTeraType !== undefined && typeof v.attackerTeraType !== 'string') return false;
    if (v.attackerVolatiles !== undefined && !isStringArray(v.attackerVolatiles)) return false;
    if (v.defenderBoosts !== undefined && !isBoostArray(v.defenderBoosts)) return false;
    if (v.defenderAilment !== undefined && typeof v.defenderAilment !== 'string') return false;
    if (v.defenderTerastallized !== undefined && typeof v.defenderTerastallized !== 'boolean') return false;
    if (v.defenderTeraType !== undefined && typeof v.defenderTeraType !== 'string') return false;
    if (v.defenderVolatiles !== undefined && !isStringArray(v.defenderVolatiles)) return false;
    if (v.defenderSideFields !== undefined && !isStringArray(v.defenderSideFields)) return false;
    if (v.weather !== undefined && typeof v.weather !== 'string') return false;
    if (v.terrain !== undefined && typeof v.terrain !== 'string') return false;
    return true;
  });
}

// opponent_build を検証する。許可されたキー(OPPONENT_BUILD_KEYS)以外が含まれる場合は拒否する
// (「PokemonSpec型に対応する任意項目のみを許容」という要件を検証段階でも徹底する)。
function validateOpponentBuild(value: unknown): { ok: true; value: OpponentBuildInput } | { ok: false; error: string } {
  if (!isPlainObject(value)) {
    return { ok: false, error: 'opponent_build must be a JSON object' };
  }
  for (const key of Object.keys(value)) {
    if (!OPPONENT_BUILD_KEYS.has(key)) {
      return { ok: false, error: `opponent_build contains an unknown key: ${key}` };
    }
  }

  const { name, level, nature, gender, abilityName, itemName, moveNames, teraType, evs, ivs } = value;

  if (!isNonEmptyString(name)) {
    return { ok: false, error: 'opponent_build.name must be a non-empty string' };
  }
  if (level !== undefined) {
    if (typeof level !== 'number' || !Number.isInteger(level) || level < MIN_LEVEL || level > MAX_LEVEL) {
      return { ok: false, error: `opponent_build.level must be an integer between ${MIN_LEVEL} and ${MAX_LEVEL}` };
    }
  }
  if (nature !== undefined && typeof nature !== 'string') {
    return { ok: false, error: 'opponent_build.nature must be a string' };
  }
  if (gender !== undefined && !VALID_GENDERS.has(gender as string)) {
    return { ok: false, error: 'opponent_build.gender must be "", "male", or "female"' };
  }
  if (abilityName !== undefined && typeof abilityName !== 'string') {
    return { ok: false, error: 'opponent_build.abilityName must be a string' };
  }
  if (itemName !== undefined && typeof itemName !== 'string') {
    return { ok: false, error: 'opponent_build.itemName must be a string' };
  }
  if (moveNames !== undefined && !isMoveNamesArray(moveNames)) {
    return { ok: false, error: 'opponent_build.moveNames must be an array of at most 4 strings' };
  }
  if (teraType !== undefined && teraType !== null && typeof teraType !== 'string') {
    return { ok: false, error: 'opponent_build.teraType must be a string or null' };
  }
  if (evs !== undefined && !isStatArray(evs, 32)) {
    return { ok: false, error: 'opponent_build.evs must be an array of 6 integers between 0 and 32' };
  }
  if (ivs !== undefined && !isStatArray(ivs, 31)) {
    return { ok: false, error: 'opponent_build.ivs must be an array of 6 integers between 0 and 31' };
  }

  const result: OpponentBuildInput = { name: name.trim() };
  if (level !== undefined) result.level = level;
  if (nature !== undefined) result.nature = nature;
  if (gender !== undefined) result.gender = gender as '' | 'male' | 'female';
  if (abilityName !== undefined) result.abilityName = abilityName;
  if (itemName !== undefined) result.itemName = itemName;
  if (moveNames !== undefined) result.moveNames = moveNames;
  if (teraType !== undefined) result.teraType = teraType;
  if (evs !== undefined) result.evs = evs;
  if (ivs !== undefined) result.ivs = ivs;
  return { ok: true, value: result };
}

// field を検証する。許可されたキー(OPPONENT_FIELD_KEYS)以外が含まれる場合は拒否する。
function validateOpponentField(value: unknown): { ok: true; value: OpponentFieldInput } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: {} };
  }
  if (!isPlainObject(value)) {
    return { ok: false, error: 'field must be a JSON object' };
  }
  for (const key of Object.keys(value)) {
    if (!OPPONENT_FIELD_KEYS.has(key)) {
      return { ok: false, error: `field contains an unknown key: ${key}` };
    }
  }

  const {
    weather,
    terrain,
    defenderSideFields,
    seed,
    critical,
    attackerBoosts,
    attackerAilment,
    attackerTerastallized,
    attackerTeraType,
    defenderBoosts,
    defenderAilment,
    defenderTerastallized,
    defenderTeraType,
    attacks,
    direction,
    order,
  } = value;

  if (weather !== undefined && typeof weather !== 'string') {
    return { ok: false, error: 'field.weather must be a string' };
  }
  if (terrain !== undefined && typeof terrain !== 'string') {
    return { ok: false, error: 'field.terrain must be a string' };
  }
  if (defenderSideFields !== undefined && !isStringArray(defenderSideFields)) {
    return { ok: false, error: 'field.defenderSideFields must be an array of strings' };
  }
  if (seed !== undefined && (typeof seed !== 'number' || !Number.isInteger(seed))) {
    return { ok: false, error: 'field.seed must be an integer' };
  }
  if (critical !== undefined && typeof critical !== 'boolean') {
    return { ok: false, error: 'field.critical must be a boolean' };
  }
  if (attackerBoosts !== undefined && !isBoostArray(attackerBoosts)) {
    return { ok: false, error: `field.attackerBoosts must be an array of ${STAT_COUNT} integers between ${BOOST_MIN} and ${BOOST_MAX}` };
  }
  if (attackerAilment !== undefined && typeof attackerAilment !== 'string') {
    return { ok: false, error: 'field.attackerAilment must be a string' };
  }
  if (attackerTerastallized !== undefined && typeof attackerTerastallized !== 'boolean') {
    return { ok: false, error: 'field.attackerTerastallized must be a boolean' };
  }
  if (attackerTeraType !== undefined && typeof attackerTeraType !== 'string') {
    return { ok: false, error: 'field.attackerTeraType must be a string' };
  }
  if (defenderBoosts !== undefined && !isBoostArray(defenderBoosts)) {
    return { ok: false, error: `field.defenderBoosts must be an array of ${STAT_COUNT} integers between ${BOOST_MIN} and ${BOOST_MAX}` };
  }
  if (defenderAilment !== undefined && typeof defenderAilment !== 'string') {
    return { ok: false, error: 'field.defenderAilment must be a string' };
  }
  if (defenderTerastallized !== undefined && typeof defenderTerastallized !== 'boolean') {
    return { ok: false, error: 'field.defenderTerastallized must be a boolean' };
  }
  if (defenderTeraType !== undefined && typeof defenderTeraType !== 'string') {
    return { ok: false, error: 'field.defenderTeraType must be a string' };
  }
  if (attacks !== undefined && !isAttacksArray(attacks)) {
    return {
      ok: false,
      error: `field.attacks must be an array of at most ${MAX_ATTACK_COUNT} items, each with a non-empty moveName and an optional hitCount integer between ${MIN_HIT_COUNT} and ${MAX_HIT_COUNT}`,
    };
  }
  // direction は未指定を許容する(既存データ互換。未指定時は 'attack' 相当として扱う)。
  if (direction !== undefined && !VALID_DIRECTIONS.has(direction as string)) {
    return { ok: false, error: 'field.direction must be "attack" or "defense"' };
  }
  // order は分数キー方式のため小数を許容する(Number.isIntegerではなくNumber.isFiniteで検証)。
  if (order !== undefined && (typeof order !== 'number' || !Number.isFinite(order))) {
    return { ok: false, error: 'field.order must be a finite number' };
  }

  const result: OpponentFieldInput = {};
  if (weather !== undefined) result.weather = weather;
  if (terrain !== undefined) result.terrain = terrain;
  if (defenderSideFields !== undefined) result.defenderSideFields = defenderSideFields;
  if (seed !== undefined) result.seed = seed;
  if (critical !== undefined) result.critical = critical;
  if (attackerBoosts !== undefined) result.attackerBoosts = attackerBoosts;
  if (attackerAilment !== undefined) result.attackerAilment = attackerAilment;
  if (attackerTerastallized !== undefined) result.attackerTerastallized = attackerTerastallized;
  if (attackerTeraType !== undefined) result.attackerTeraType = attackerTeraType;
  if (defenderBoosts !== undefined) result.defenderBoosts = defenderBoosts;
  if (defenderAilment !== undefined) result.defenderAilment = defenderAilment;
  if (defenderTerastallized !== undefined) result.defenderTerastallized = defenderTerastallized;
  if (defenderTeraType !== undefined) result.defenderTeraType = defenderTeraType;
  if (attacks !== undefined) {
    // moveName の前後空白を除去する(opponent_build.name/move_name と同じ正規化の流儀)。
    // 既知キーだけを明示的にコピーする(isAttacksArrayのコメント参照: 未知キーは
    // ここで自然に読み捨てられる)。
    result.attacks = (attacks as OpponentAttackInput[]).map((attack) => {
      const normalized: OpponentAttackInput = { moveName: attack.moveName.trim() };
      if (attack.hitCount !== undefined) normalized.hitCount = attack.hitCount;
      if (attack.critical !== undefined) normalized.critical = attack.critical;
      if (attack.stealthRock !== undefined) normalized.stealthRock = attack.stealthRock;
      if (attack.defenderDisguiseBroken !== undefined) normalized.defenderDisguiseBroken = attack.defenderDisguiseBroken;
      if (attack.spikes !== undefined) normalized.spikes = attack.spikes;
      if (attack.attackerBoosts !== undefined) normalized.attackerBoosts = attack.attackerBoosts;
      if (attack.attackerAilment !== undefined) normalized.attackerAilment = attack.attackerAilment;
      if (attack.attackerTerastallized !== undefined) normalized.attackerTerastallized = attack.attackerTerastallized;
      if (attack.attackerTeraType !== undefined) normalized.attackerTeraType = attack.attackerTeraType;
      if (attack.attackerVolatiles !== undefined) normalized.attackerVolatiles = attack.attackerVolatiles;
      if (attack.defenderBoosts !== undefined) normalized.defenderBoosts = attack.defenderBoosts;
      if (attack.defenderAilment !== undefined) normalized.defenderAilment = attack.defenderAilment;
      if (attack.defenderTerastallized !== undefined) normalized.defenderTerastallized = attack.defenderTerastallized;
      if (attack.defenderTeraType !== undefined) normalized.defenderTeraType = attack.defenderTeraType;
      if (attack.defenderVolatiles !== undefined) normalized.defenderVolatiles = attack.defenderVolatiles;
      if (attack.defenderSideFields !== undefined) normalized.defenderSideFields = attack.defenderSideFields;
      if (attack.weather !== undefined) normalized.weather = attack.weather;
      if (attack.terrain !== undefined) normalized.terrain = attack.terrain;
      return normalized;
    });
  }
  if (direction !== undefined) result.direction = direction as 'attack' | 'defense';
  if (order !== undefined) result.order = order;
  return { ok: true, value: result };
}

export function validateOpponentNoteRequestBody(
  body: unknown,
  options: ValidateOpponentNoteOptions,
): OpponentNoteValidationResult {
  if (!isPlainObject(body)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }

  const { owned_pokemon_id, opponent_build, field, move_name, client_result, memo } = body;

  let ownedPokemonId: string | null = null;
  if (options.requireOwnedPokemonId) {
    if (typeof owned_pokemon_id !== 'string' || !UUID_PATTERN.test(owned_pokemon_id)) {
      return { ok: false, error: 'owned_pokemon_id must be a valid uuid string' };
    }
    ownedPokemonId = owned_pokemon_id;
  }

  const buildResult = validateOpponentBuild(opponent_build);
  if (!buildResult.ok) return buildResult;

  const fieldResult = validateOpponentField(field);
  if (!fieldResult.ok) return fieldResult;

  if (move_name !== undefined && move_name !== null && typeof move_name !== 'string') {
    return { ok: false, error: 'move_name must be a string' };
  }
  if (client_result !== undefined && client_result !== null && !isPlainObject(client_result)) {
    return { ok: false, error: 'client_result must be a JSON object' };
  }
  if (memo !== undefined && memo !== null && typeof memo !== 'string') {
    return { ok: false, error: 'memo must be a string' };
  }

  return {
    ok: true,
    value: {
      owned_pokemon_id: ownedPokemonId,
      opponent_build: buildResult.value,
      field: fieldResult.value,
      move_name: typeof move_name === 'string' ? (move_name.trim() === '' ? null : move_name.trim()) : null,
      client_result: (client_result as Record<string, unknown> | null | undefined) ?? null,
      memo: typeof memo === 'string' ? (memo.trim() === '' ? null : memo.trim()) : null,
    },
  };
}
