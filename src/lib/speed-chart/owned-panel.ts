// すばやさ早見表(/speed-chart)「この個体」セルのレンダラ。
//
// R-13(確定した設計): 「この個体」列は独立したカラムではなく、ChartTable側(chart-table.ts)が
// 1行ぶん組み立てるたびに呼び出す「セルのレンダラ」。このファイルの責務(ファイル分割表どおり):
//   - その個体で実現可能なすばやさ実数値の列挙(素の性格3種×S努力値0〜32×持ち物2種の直積。
//     ランク上昇は含めない。P1確定仕様)
//   - 「この個体」セルの3状態描画(R-7: 現在[クリック不可] / [性格 努力値N]ボタン / −。
//     ボタン下の内訳テキストはUI改修2026-08-02第3弾要件3で廃止した。「現在」マーカーの矢印は
//     UI改修2026-08-02第4弾要件1で廃止した)
//   - クリック時の PUT /api/owned-pokemon/:id(R-1: 全項目上書き契約を厳守。埋め込まれた
//     レコード全体をspreadしてから nature/evs/item_name の3項目だけ上書きする)
//   - 保存失敗時の表示(R-10: エラー文言・現在マーカーを動かさない・候補を再クリック可能に戻す)
//   - 調整ボタンが提案する性格の、現在の性格に対する「近さ」の調整(UI改修2026-08-02第4弾
//     要件3。selectMinimalCostSpeedOption()が返す性格をこのファイル側で置き換える。詳細は
//     pickReplacementNature()のコメント参照)
//
// 共有状態の所有(R-12): 「個体の現在のS実数値」はこのモジュールが所有する。chart-table.ts へは
// document 上の CustomEvent(OWNED_CURRENT_VALUE_EVENT)で一方向に通知するだけで、chart-table.ts
// 側の変数を直接参照することはない。逆方向(レギュレーション変更でscarfModifier等が変わる場合)は
// chart-table.ts がこの initOwnedPanel() を都度呼び直す(exportされた関数のimport経由の呼び出し。
// クロージャ共有はしない)。
import {
  applySpeedMultiplier,
  buildAppliedEvs,
  enumerateReachableSpeedValues,
  getNatureSpeedEffect,
  selectMinimalCostSpeedOption,
  type SpeedModifierMultiplier,
  type SpeedTargetSelection,
} from '../speed-chart';
import { calcOtherStat, NATURE_STAT_MODIFIERS } from '../stats';
import { validateSpeedChartApplyPayload } from '../speed-chart-validation';
import type { OwnedPokemonRecord } from '../owned-pokemon';
import { spriteUrl } from '../pokemon-master-data';

export const OWNED_CURRENT_VALUE_EVENT = 'speed-chart:owned-current-changed';

export interface OwnedCurrentValueEventDetail {
  value: number;
}

// 追加改修(2026-08-01第2弾)要件4・R-12更新: 「個体が到達可能な実数値の集合」はこのモジュールが
// 所有し、CustomEventでchart-table.tsへ一方向に通知する(panel→table)。chart-table.tsはこれを
// 受けて行の表示/非表示を切り替えるだけで、combos自体(このモジュールの内部状態)には触れない。
export const OWNED_REACHABLE_VALUES_EVENT = 'speed-chart:owned-reachable-values-changed';

export interface OwnedReachableValuesEventDetail {
  values: number[];
}

export interface OwnedPanelContext {
  /** index.astro が <script type="application/json"> で埋め込んだレコード全体(R-1)。 */
  ownedRecord: OwnedPokemonRecord;
  baseSpeed: number;
  /**
   * こだわりスカーフの倍率補正。メガ種族(R-4)、またはそのレギュレーションでスカーフが
   * 使えない場合は呼び出し側(chart-table.ts)が null を渡す。
   */
  scarfModifier: SpeedModifierMultiplier | null;
  /**
   * scarfModifier に対応する持ち物名。speed-modifiers.json から動的に見つけた名前を
   * chart-table.ts が渡す(このファイル・chart-table.ts のどちらにも「こだわりスカーフ」という
   * 文字列をハードコードしない。speed-chart.ts 冒頭コメントの方針と同じ)。scarfModifier が
   * null のときは null。
   */
  scarfItemName: string | null;
  /**
   * 個体サマリのアイコン(1段目)用のスプライトID(PokeAPIの画像ID)。
   * chart-table.ts が imageIdByName.get(ownedRecord.species_name) ?? null を渡す。
   * フォルム名がマスターデータに見つからない等でnullのときは、アイコン段は
   * hiddenのまま(何も表示しない。UI改修2026-08-02第3弾要件1)。
   */
  spriteImageId: number | null;
}

export interface OwnedPanelController {
  /** 現在把握している個体のS実数値(panel所有の状態。R-12)。 */
  getCurrentValue(): number;
  /** chart-table.ts が1行ぶん組み立てるときに呼ぶ。「この個体」セルのDOM要素を返す。 */
  renderCell(rowValue: number): HTMLElement;
}

const SUMMARY_SPRITE_ID = 'speed-chart-owned-summary-sprite';
const SUMMARY_SPECIES_ID = 'speed-chart-owned-summary-species';
const SUMMARY_ABILITY_ID = 'speed-chart-owned-summary-ability';
const SUMMARY_NATURE_ID = 'speed-chart-owned-summary-nature';
const SUMMARY_ITEM_ID = 'speed-chart-owned-summary-item';
const SUMMARY_EVS_ID = 'speed-chart-owned-summary-evs';
const SUMMARY_VALUE_ID = 'speed-chart-owned-summary-value';
const ERROR_BANNER_ID = 'speed-chart-owned-error';

const NATURE_EFFECT_MODIFIER: Record<'up' | 'neutral' | 'down', number> = {
  up: 1.1,
  neutral: 1.0,
  down: 0.9,
};

// 要件2(2026-08-02第3弾): 「調整」ボタンはクリックすると保存して/box/<id>へページ遷移する
// ため、そのことを示す「四角から右上に矢印が出る」外部リンク/ページジャンプの一般的な
// アイコン(feather iconsのexternal-linkと同形)をボタン先頭に付ける。このファイルは
// JSからDOMを生成する設計(冒頭コメント参照)のため、SVGもcreateElementNSで組み立てる
// (box-id/right-panel.tsの矢印アイコン生成と同じパターン)。色はstroke="currentColor"で
// ボタンのテキスト色を継承させ、新色は追加しない。
function createJumpIcon(): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'speed-chart-apply-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  // 四角(左下に開いた箱)。
  const box = document.createElementNS(ns, 'path');
  box.setAttribute('d', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6');
  svg.appendChild(box);

  // 右上へ突き抜ける矢印(矢じりの折れ線+対角線)。
  const arrowHead = document.createElementNS(ns, 'path');
  arrowHead.setAttribute('d', 'M15 3h6v6');
  svg.appendChild(arrowHead);

  const arrowShaft = document.createElementNS(ns, 'path');
  arrowShaft.setAttribute('d', 'M10 14 21 3');
  svg.appendChild(arrowShaft);

  return svg;
}

// 要件3(2026-08-02第4弾): selectMinimalCostSpeedOption() が性格を変える必要があると
// 判断したとき、代表として選ぶ性格(pickNatureNameForSpeedEffect、NATURE_STAT_MODIFIERSの
// 定義順で機械的に選ぶ = up→おくびょう/down→ゆうかん/neutral→まじめ固定)は、現在の性格との
// 「近さ」を考慮しない。例えばいじっぱり(上昇=攻撃/下降=特攻、攻撃型)の個体にすばやさ下降の
// 選択肢を提示すると「ゆうかん」ではなく機械的に「おくびょう」(下降=攻撃)が出てしまい、
// 攻撃型なのに攻撃が下がる提案になる。
//
// すばやさへの効果(up/neutral/down)が同じ性格同士は実数値が完全に同一(NATURE_EFFECT_MODIFIER
// は effect だけで決まり性格名には依存しない)なので、selection.nature を「同じeffectの中で
// 別の性格名に差し替える」のは evSpe・usesScarf(=努力値・持ち物の選択結果)に一切影響しない
// 安全な操作。src/lib/speed-chart.ts は編集禁止のため、この差し替えはこちら側で行う。
//
// 優先順位: ①現在の性格とdownが一致 → ②現在の性格とupが一致 → ③NATURE_STAT_MODIFIERSの
// 定義順(Array.prototype.sortの安定性により決定的)。
// 例: いじっぱり(up=atk/down=spa)の個体ですばやさ上昇(up)を選ぶ場合、
//     downがspaで一致する「ようき」(up=spe/down=spa)が①で選ばれる。
//     すばやさ下降(down)を選ぶ場合、downがspaで一致する候補は存在しない(down=speの性格しか
//     対象にならないため)ので②upがatkで一致する「ゆうかん」(up=atk/down=spe)が選ばれる。
//     ようき(up=spe/down=spa)の個体ですばやさ無補正(neutral)を選ぶ場合、neutralの候補は
//     「すばやさに影響しない性格すべて」(無補正5種に限らない)なので、downがspaで一致する
//     「いじっぱり」(up=atk/down=spa)が①で選ばれる(無補正5種の「まじめ」ではない)。
//     現在の性格自体が無補正5種(down=null)なら、候補中でdown=nullが一致するのも無補正5種
//     だけなので、従来どおり「まじめ」等が①で選ばれる。
function pickReplacementNature(effect: 'up' | 'neutral' | 'down', currentNature: string, fallback: string): string {
  const currentModifier = NATURE_STAT_MODIFIERS[currentNature];
  const candidates = Object.entries(NATURE_STAT_MODIFIERS).filter(([, modifier]) => {
    if (effect === 'up') return modifier.up === 'spe';
    if (effect === 'down') return modifier.down === 'spe';
    // neutral: すばやさ(spe)が上昇にも下降にも関わらない性格すべて(無補正5種に限らない。
    // 例: いじっぱり up=atk/down=spa もすばやさに対しては無補正)。
    return modifier.up !== 'spe' && modifier.down !== 'spe';
  });
  if (candidates.length === 0) return fallback; // 型上は到達しない安全側フォールバック。

  const sorted = [...candidates].sort(([, a], [, b]) => {
    const aDownMatch = currentModifier && a.down === currentModifier.down ? 0 : 1;
    const bDownMatch = currentModifier && b.down === currentModifier.down ? 0 : 1;
    if (aDownMatch !== bDownMatch) return aDownMatch - bDownMatch;
    const aUpMatch = currentModifier && a.up === currentModifier.up ? 0 : 1;
    const bUpMatch = currentModifier && b.up === currentModifier.up ? 0 : 1;
    return aUpMatch - bUpMatch;
  });
  return sorted[0][0];
}

export function initOwnedPanel(ctx: OwnedPanelContext): OwnedPanelController {
  // 個体の「現在値」(性格・S努力値・持ち物)。要件2により適用成功後は/box/<id>へ遷移する
  // ため、これらは初期化後に書き換わらない(以前はR-10「留まって再描画」のためletで更新して
  // いたが、遷移する設計になったため定数化した)。
  const currentNature: string | null = ctx.ownedRecord.nature;
  const currentEvs: number[] = [...ctx.ownedRecord.evs];
  const currentItem: string | null = ctx.ownedRecord.item_name;

  // 到達可能な組み合わせ自体は現在値に依存しない(性格・持ち物の「現在値と同じか」は
  // selectMinimalCostSpeedOption 側のタイブレークでのみ使う)ため、regulation変更を除き
  // 再列挙は不要。
  const combos = enumerateReachableSpeedValues({
    baseSpeed: ctx.baseSpeed,
    currentNature,
    scarfModifier: ctx.scarfModifier,
  });

  const currentValue = computeCurrentValue();

  function usesScarfNow(): boolean {
    return !!ctx.scarfModifier && !!ctx.scarfItemName && currentItem === ctx.scarfItemName;
  }

  function computeCurrentValue(): number {
    const effect = getNatureSpeedEffect(currentNature);
    const base = calcOtherStat(50, ctx.baseSpeed, 31, currentEvs[5] ?? 0, NATURE_EFFECT_MODIFIER[effect]);
    return usesScarfNow() && ctx.scarfModifier
      ? applySpeedMultiplier(base, ctx.scarfModifier.numerator, ctx.scarfModifier.denominator)
      : base;
  }

  // UI改修(2026-08-02第3弾)要件1: 個体サマリを5段構成(アイコン/ニックネーム/特性・
  // アイテム/性格・努力値/S実数値)にする。特性・努力値の2段はここで新規に追加した
  // (以前は性格・持ち物バッジの1段のみだった)。
  function updateSummary(): void {
    // 1段目: アイコン。spriteImageIdが無い個体(マスターデータに未登録のフォルム等)は
    // hiddenのままにする(pitfalls.md: 画像が無いときは要素ごと隠す)。
    const spriteEl = document.getElementById(SUMMARY_SPRITE_ID) as HTMLImageElement | null;
    if (spriteEl) {
      if (ctx.spriteImageId != null) {
        spriteEl.src = spriteUrl(ctx.spriteImageId);
        spriteEl.hidden = false;
      } else {
        spriteEl.hidden = true;
      }
    }
    // 2段目: ニックネーム(無ければ種族名)。
    const speciesEl = document.getElementById(SUMMARY_SPECIES_ID);
    if (speciesEl) speciesEl.textContent = ctx.ownedRecord.nickname || ctx.ownedRecord.species_name;
    // 3段目: 特性・アイテム。
    const abilityEl = document.getElementById(SUMMARY_ABILITY_ID);
    if (abilityEl) abilityEl.textContent = ctx.ownedRecord.ability_name ?? '特性未設定';
    const itemEl = document.getElementById(SUMMARY_ITEM_ID);
    if (itemEl) itemEl.textContent = currentItem ?? '持ち物なし';
    // 4段目: 性格・努力値。このページの主題がすばやさのため、努力値はS努力値
    // (currentEvs[5])を表示する(チャンピオンズルールの0〜32スケールは仕様)。
    const natureEl = document.getElementById(SUMMARY_NATURE_ID);
    if (natureEl) natureEl.textContent = currentNature ?? '性格未設定';
    const evsEl = document.getElementById(SUMMARY_EVS_ID);
    // UI改修2026-08-02第4弾要件2: 「努力値n」のnの前に半角スペースを入れる(調整ボタンの
    // 表記と揃える。可読性のため)。
    if (evsEl) evsEl.textContent = `努力値 ${currentEvs[5] ?? 0}`;
    // 5段目: S実数値。
    const valueEl = document.getElementById(SUMMARY_VALUE_ID);
    if (valueEl) valueEl.textContent = `S実数値 ${currentValue}`;
  }

  function showError(message: string): void {
    const el = document.getElementById(ERROR_BANNER_ID);
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
  }

  function clearError(): void {
    const el = document.getElementById(ERROR_BANNER_ID);
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
  }

  function dispatchCurrentValueChanged(): void {
    document.dispatchEvent(
      new CustomEvent<OwnedCurrentValueEventDetail>(OWNED_CURRENT_VALUE_EVENT, { detail: { value: currentValue } }),
    );
  }

  function dispatchReachableValuesChanged(): void {
    document.dispatchEvent(
      new CustomEvent<OwnedReachableValuesEventDetail>(OWNED_REACHABLE_VALUES_EVENT, {
        detail: { values: combos.map((combo) => combo.value) },
      }),
    );
  }

  function paintCell(rowValue: number, el: HTMLElement): void {
    el.replaceChildren();
    el.classList.remove('is-current', 'is-reachable', 'is-unreachable');

    // 状態1: 現在値そのもの(R-7: 現在、クリック不可)。UI改修2026-08-02第4弾要件1: 「← 現在」の
    // 矢印は他の行の調整ボタン(先頭にページジャンプアイコンが付く)と並んだときに紛らわしいため
    // 廃止し、テキストを「現在」のみにした。
    if (rowValue === currentValue) {
      el.classList.add('is-current');
      const marker = document.createElement('span');
      marker.className = 'speed-chart-owned-current badge';
      marker.textContent = '現在';
      el.appendChild(marker);
      return;
    }

    const rawSelection = selectMinimalCostSpeedOption(combos, rowValue, currentNature, usesScarfNow());

    // 状態3: 到達不可(R-7: −、muted)。
    if (!rawSelection) {
      el.classList.add('is-unreachable');
      const dash = document.createElement('span');
      dash.className = 'speed-chart-owned-dash';
      dash.textContent = '−';
      el.appendChild(dash);
      return;
    }

    // 要件3(2026-08-02第4弾): selectMinimalCostSpeedOption()が性格を変える提案をした場合、
    // 代表性格を「現在の性格に近いもの(下降補正が同じもの優先)」へ差し替える
    // (pickReplacementNatureのコメント参照)。「性格を変えない」選択(rawSelection.natureが
    // 既に現在の性格そのもの)や現在の性格が未設定(null)のときはpickReplacementNature側で
    // 何もせずrawSelectionをそのまま返す。表示用(このあとのbuttonParts)と保存用
    // (handleApplyへ渡すペイロード)が食い違わないよう、差し替えはここ1箇所だけで行う。
    const selection: SpeedTargetSelection =
      currentNature && rawSelection.nature !== currentNature
        ? { ...rawSelection, nature: pickReplacementNature(getNatureSpeedEffect(rawSelection.nature), currentNature, rawSelection.nature) }
        : rawSelection;

    // 状態2: 到達可能([アイコン]性格 努力値N[ アイテム]のボタン。内訳テキストは廃止済み)。
    el.classList.add('is-reachable');
    const wrap = document.createElement('div');
    wrap.className = 'speed-chart-owned-option';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-primary speed-chart-apply-button';
    // 要件2(2026-08-01第4弾、2026-08-02第3弾で改訂): 汎用的な「ここにする」ではなく、
    // このボタンを押すと個体の性格・S努力値・アイテムが具体的に何になるかをボタン自体の
    // テキストにする(下にあった内訳テキストは廃止したため、ボタン単体を見ただけで
    // 結果が分かる必要がある)。アイテムは、この候補がすばやさ補正アイテム
    // (こだわりスカーフ等)を使う場合だけ末尾に続ける(無関係な現在の持ち物名まで出すと
    // 「持ち物も変わる」と誤読されるため)。「S努力値」の「S」は右パネル自体が
    // すばやさ調整専用になった(要件1)ため冗長と判断し「努力値」に短縮、区切りの
    // スラッシュも廃止してスペース区切りにした(例: 「ようき 努力値 6」
    // 「ゆうかん 努力値 32 こだわりスカーフ」)。UI改修2026-08-02第4弾要件2で
    // 「努力値」と数値の間にも半角スペースを追加した(右パネルの努力値バッジの表記と揃える)。
    const buttonParts = [selection.nature, `努力値 ${selection.evSpe}`];
    if (selection.usesScarf && ctx.scarfItemName) buttonParts.push(ctx.scarfItemName);
    // ボタンを押すと保存後に/box/<id>へ遷移する(下のhandleApply参照)ため、先頭に
    // ページジャンプを表すインラインSVGアイコンを付ける(要件2)。
    button.append(createJumpIcon(), document.createTextNode(buttonParts.join(' ')));
    button.addEventListener('click', () => {
      void handleApply(selection, button);
    });

    wrap.append(button);

    // 要件10: 努力値合計が66を超える組み合わせは警告表示のみ(適用はブロックしない。
    // チャンピオンズルールの合計上限66は入力制限を持たない仕様)。
    const appliedEvs = buildAppliedEvs(currentEvs, selection.evSpe);
    const total = appliedEvs.reduce((sum, v) => sum + v, 0);
    if (total > 66) {
      const warning = document.createElement('div');
      warning.className = 'speed-chart-ev-warning';
      warning.textContent = `努力値合計${total}(66超。適用は可能です)`;
      wrap.appendChild(warning);
    }

    el.appendChild(wrap);
  }

  async function handleApply(selection: SpeedTargetSelection, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    clearError();

    const itemName = selection.usesScarf ? ctx.scarfItemName : currentItem;
    const validated = validateSpeedChartApplyPayload({ nature: selection.nature, evSpe: selection.evSpe, itemName });
    if (!validated.ok) {
      showError(`適用できませんでした: ${validated.error}`);
      button.disabled = false;
      return;
    }

    const appliedEvs = buildAppliedEvs(currentEvs, validated.value.evSpe);
    // R-1: 埋め込まれたレコード全体をspreadしてから3項目だけ上書きする(全項目上書き契約。
    // 積み戻しを忘れるとメモ・タグ・技・レギュレーション等が黙って消える)。
    const payload = {
      ...ctx.ownedRecord,
      nature: validated.value.nature,
      evs: appliedEvs,
      item_name: validated.value.itemName,
    };

    try {
      const res = await fetch(`/api/owned-pokemon/${ctx.ownedRecord.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        // R-10: 保存失敗時は ← 現在 マーカーを動かさず(=状態を更新しない)、
        // クリックした候補を再クリックできる状態に戻す(button.disabled = false)。
        showError(`保存に失敗しました(${res.status}): ${body?.error ?? '不明なエラー'}`);
        button.disabled = false;
        return;
      }
    } catch (err) {
      showError(`保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      button.disabled = false;
      return;
    }

    // 要件2(2026-08-01第2弾): 適用成功後は個体編集画面(/box/<id>)へ戻る。
    // R-10で決めた「成功後もページに留まり続けて別の行を適用できる」はユーザー指示により撤回。
    // 内部状態の更新・再描画は不要(このままページ遷移する)。
    window.location.href = `/box/${ctx.ownedRecord.id}`;
  }

  updateSummary();
  // 初期化直後にも1回発火させる。chart-table.ts はこの値をrender()完了後に直接
  // getCurrentValue() 経由で読むため、この初回発火自体は使わないが(rowElementsがまだ
  // 空のため)、以後の状態変化(適用成功時)を検知するリスナーを初期化前に登録しても
  // 一貫した経路になるようここでも発火させておく。
  dispatchCurrentValueChanged();
  // 要件4: 到達可能な実数値の集合をchart-table.tsへ通知する(初期表示のデフォルトフィルタに使う)。
  dispatchReachableValuesChanged();

  return {
    getCurrentValue: () => currentValue,
    renderCell(rowValue: number): HTMLElement {
      const el = document.createElement('div');
      el.className = 'speed-chart-owned';
      paintCell(rowValue, el);
      return el;
    },
  };
}
