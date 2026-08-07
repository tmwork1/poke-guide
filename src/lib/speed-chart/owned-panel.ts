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
  applySpeedRank,
  buildAppliedEvs,
  enumerateReachableSpeedValues,
  getNatureSpeedEffect,
  selectMinimalCostSpeedOptions,
  type SpeedModifierEntry,
  type SpeedModifierMultiplier,
  type SpeedTargetSelection,
} from '../speed-chart';
import { calcOtherStat, NATURE_STAT_MODIFIERS } from '../stats';
import { validateSpeedChartApplyPayload } from '../speed-chart-validation';
import type { OwnedPokemonRecord } from '../owned-pokemon';
import { spriteUrl } from '../pokemon-master-data';
import { itemIconUrl, loadItemSpriteMap } from '../sprite-urls';

export const OWNED_CURRENT_VALUE_EVENT = 'speed-chart:owned-current-changed';

export interface OwnedCurrentValueEventDetail {
  value: number;
  /** ランク操作による変更時だけ表を再描画して移動する。 */
  navigate?: boolean;
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
  /** この個体の特性に対応する補正。マスター未登録なら null。 */
  abilityModifier: SpeedModifierEntry | null;
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

// 要件2(2026-08-02第3弾、2026-08-02第5弾でアイコン差し替え): 「調整」ボタンはクリックすると
// 保存して/box/<id>へページ遷移する(この挙動自体は変更なし)。以前は「四角から右上に矢印が
// 出る」ページジャンプ/外部リンクの一般的なアイコンを先頭に付けていたが、ユーザー指示により
// 編集アイコン(鉛筆)へ差し替えた。右パネルの「編集」ボタン(OwnedPanel.astro)が既に同じ
// 鉛筆のpathを使っているため、意匠を統一する狙いで同じpathをそのまま流用する。このファイルは
// JSからDOMを生成する設計(冒頭コメント参照)のため、SVGもcreateElementNSで組み立てる
// (box-id/right-panel.tsの矢印アイコン生成と同じパターン)。色はstroke="currentColor"で
// ボタンのテキスト色を継承させ、新色は追加しない。`speed-chart-apply-icon`クラスは
// OwnedPanel.astro側のCSSが参照しているため据え置く。
function createRefreshIcon(): SVGElement {
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

  // UI改修(2026-08-06): 保存値の更新を表すlucide refresh-cw相当の円形矢印。
  const body = document.createElementNS(ns, 'path');
  body.setAttribute('d', 'M21 12a9 9 0 1 1-2.64-6.36');
  svg.appendChild(body);

  const tip = document.createElementNS(ns, 'path');
  tip.setAttribute('d', 'M21 3v6h-6');
  svg.appendChild(tip);

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
  let rankStages = 0;
  let considerAbility = false;
  let considerItem = true;
  let combos = buildCombos();
  let currentValue = computeCurrentValue();
  const renderedCells = new Map<number, HTMLElement>();

  function usesScarfNow(): boolean {
    return considerItem && !!ctx.scarfModifier && !!ctx.scarfItemName && currentItem === ctx.scarfItemName;
  }

  function activeAbilityModifier(): SpeedModifierEntry | null {
    return considerAbility ? ctx.abilityModifier : null;
  }

  function buildCombos(): ReturnType<typeof enumerateReachableSpeedValues> {
    return enumerateReachableSpeedValues({
      baseSpeed: ctx.baseSpeed,
      currentNature,
      scarfModifier: considerItem ? ctx.scarfModifier : null,
      abilityModifier: activeAbilityModifier(),
      rankStages,
    });
  }

  function computeCurrentValue(): number {
    const effect = getNatureSpeedEffect(currentNature);
    const base = calcOtherStat(50, ctx.baseSpeed, 31, currentEvs[5] ?? 0, NATURE_EFFECT_MODIFIER[effect]);
    const ability = activeAbilityModifier();
    const abilityRank = ability?.kind === 'rank' ? ability.stages : 0;
    const ranked = applySpeedRank(base, rankStages + abilityRank);
    const abilityAdjusted = ability?.kind === 'multiplier'
      ? applySpeedMultiplier(ranked, ability.numerator, ability.denominator)
      : ranked;
    return usesScarfNow() && ctx.scarfModifier
      ? applySpeedMultiplier(abilityAdjusted, ctx.scarfModifier.numerator, ctx.scarfModifier.denominator)
      : abilityAdjusted;
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
    if (itemEl) {
      itemEl.replaceChildren();
      if (currentItem) {
        // UI改修(2026-08-06): 既存のアイテムマスターと正規化済み画像URLを再利用する。
        const text = document.createElement('span');
        text.textContent = currentItem;
        // UI不具合修正(2026-08-06): 一行省略時にも名称全体を確認できるようにする。
        itemEl.title = currentItem;
        itemEl.appendChild(text);
        void loadItemSpriteMap().then((map) => {
          const spritePath = map.get(currentItem);
          if (!spritePath || !itemEl.isConnected || itemEl.querySelector('img')) return;
          const image = document.createElement('img');
          image.alt = '';
          image.src = itemIconUrl(spritePath);
          image.addEventListener('error', () => image.remove(), { once: true });
          itemEl.prepend(image);
        });
      } else {
        itemEl.removeAttribute('title');
        itemEl.textContent = 'アイテムなし';
      }
    }
    // 4段目: 性格・努力値。このページの主題がすばやさのため、努力値はS努力値
    // (currentEvs[5])を表示する(チャンピオンズルールの0〜32スケールは仕様)。
    const natureEl = document.getElementById(SUMMARY_NATURE_ID);
    if (natureEl) natureEl.textContent = currentNature ?? '性格未設定';
    const evsEl = document.getElementById(SUMMARY_EVS_ID);
    // UI改修2026-08-02第4弾要件2: 「努力値n」のnの前に半角スペースを入れる(調整ボタンの
    // 表記と揃える。可読性のため)。
    if (evsEl) evsEl.textContent = `努力値 ${currentEvs[5] ?? 0}`;
    // 5段目: すばやさ実数値。
    // UI改修依頼(すばやさ早見表、2026-08-02)「S実数値 xxx を すばやさ xxx に変える」
    // 「現在地へ戻るボタンを削除し、この表示自体をボタン化して同じ動作を担わせる」:
    // 表示文言を変更し、<button>化(OwnedPanel.astro側)に伴いaria-labelも動的に設定する。
    // WCAG 2.5.3 Label in Name対応のため、可視テキスト(「すばやさ xxx」)をそのまま含めた
    // 文言にする(アクセシブルネームが可視ラベルの文言を包含しないと、音声操作利用者が
    // 可視ラベルどおりに発話しても一致しない)。クリック時の実際のスクロール処理は
    // src/lib/speed-chart/chart-table.ts側でこのidにイベントリスナーを登録して行う
    // (旧#speed-chart-back-to-currentと同じ動作。「個体の現在値」自体はこのモジュールが
    // 所有するR-12の方針どおり、ここでは表示だけを更新しスクロールは行わない)。
    const valueEl = document.getElementById(SUMMARY_VALUE_ID);
    if (valueEl) {
      valueEl.textContent = `すばやさ ${currentValue}`;
    }
  }

  // UI改修(2026-08-06): /box/[id]と同じ入力確定・端点無効・ホイール抑止で表示専用ランクを扱う。
  const rankInput = document.getElementById('speed-chart-rank-input') as HTMLInputElement | null;
  const rankIncrement = document.getElementById('speed-chart-rank-increment') as HTMLButtonElement | null;
  const rankDecrement = document.getElementById('speed-chart-rank-decrement') as HTMLButtonElement | null;
  const abilityToggle = document.getElementById('speed-chart-ability-toggle') as HTMLInputElement | null;
  const itemToggle = document.getElementById('speed-chart-item-toggle') as HTMLInputElement | null;
  if (abilityToggle) {
    abilityToggle.disabled = !ctx.abilityModifier;
    abilityToggle.title = ctx.abilityModifier ? '' : 'この特性にすばやさ補正はありません';
  }
  const clampRank = (value: number): number => Math.max(-6, Math.min(6, Math.trunc(value)));
  const updateRankControls = (rank: number): void => {
    rankInput?.classList.toggle('is-nonzero', rank !== 0);
    if (rankIncrement) rankIncrement.disabled = rank >= 6;
    if (rankDecrement) rankDecrement.disabled = rank <= -6;
  };
  const commitRank = (fallbackToZeroIfEmpty: boolean): void => {
    if (!rankInput) return;
    const raw = rankInput.value.trim();
    if (!fallbackToZeroIfEmpty && (raw === '' || raw === '-')) return;
    const parsed = raw === '' || raw === '-' || !Number.isFinite(Number(raw)) ? 0 : Number(raw);
    rankStages = clampRank(parsed);
    rankInput.value = String(rankStages);
    updateRankControls(rankStages);
    recalculate();
  };
  const recalculate = (): void => {
    combos = buildCombos();
    currentValue = computeCurrentValue();
    updateSummary();
    for (const [value, cell] of renderedCells) paintCell(value, cell);
    dispatchReachableValuesChanged();
    dispatchCurrentValueChanged(true);
  };
  rankInput?.addEventListener('input', () => commitRank(false));
  rankInput?.addEventListener('change', () => commitRank(true));
  rankInput?.addEventListener('blur', () => commitRank(true));
  rankInput?.addEventListener('wheel', (event) => {
    if (document.activeElement === rankInput) event.preventDefault();
  }, { passive: false });
  rankIncrement?.addEventListener('click', () => {
    if (!rankInput) return;
    rankInput.value = String(clampRank((Number(rankInput.value) || 0) + 1));
    commitRank(true);
  });
  rankDecrement?.addEventListener('click', () => {
    if (!rankInput) return;
    rankInput.value = String(clampRank((Number(rankInput.value) || 0) - 1));
    commitRank(true);
  });
  abilityToggle?.addEventListener('change', () => {
    considerAbility = abilityToggle.checked && !!ctx.abilityModifier;
    recalculate();
  });
  itemToggle?.addEventListener('change', () => {
    considerItem = itemToggle.checked;
    recalculate();
  });
  updateRankControls(0);

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

  function dispatchCurrentValueChanged(navigate = false): void {
    document.dispatchEvent(
      new CustomEvent<OwnedCurrentValueEventDetail>(OWNED_CURRENT_VALUE_EVENT, { detail: { value: currentValue, navigate } }),
    );
  }

  function dispatchReachableValuesChanged(): void {
    document.dispatchEvent(
      new CustomEvent<OwnedReachableValuesEventDetail>(OWNED_REACHABLE_VALUES_EVENT, {
        // UI改修(2026-08-06): 絞り込み中もランク補正後の現在行を必ず残す。
        detail: { values: [...combos.map((combo) => combo.value), currentValue] },
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

    const rawSelections = selectMinimalCostSpeedOptions(combos, rowValue, currentNature, usesScarfNow());

    // 状態3: 到達不可(R-7: −、muted)。
    if (rawSelections.length === 0) {
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
    const selections: SpeedTargetSelection[] = rawSelections.map((rawSelection) =>
      currentNature && rawSelection.nature !== currentNature
        ? { ...rawSelection, nature: pickReplacementNature(getNatureSpeedEffect(rawSelection.nature), currentNature, rawSelection.nature) }
        : rawSelection,
    );

    // 状態2: 到達可能([アイコン]性格 努力値N[ アイテム]のボタン。内訳テキストは廃止済み)。
    el.classList.add('is-reachable');
    const wrap = document.createElement('div');
    wrap.className = 'speed-chart-owned-option';

    for (const selection of selections) {
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
    // ボタンを押すと保存後に/box/<id>へ遷移する(下のhandleApply参照)。押下結果を
    // その場で編集することを表す編集アイコン(鉛筆)を先頭に付ける(要件2、
    // 2026-08-02第5弾でページジャンプアイコンから差し替え。右パネルの編集ボタンと意匠を統一)。
      const buttonLabel = buttonParts.join(' / ');
    // UI不具合修正(2026-08-06): flex直下のテキストノードをspanで包み、省略記号を確実に表示する。
      const label = document.createElement('span');
      label.className = 'speed-chart-apply-label';
      label.textContent = buttonLabel;
      button.title = selection.usesScarf && ctx.scarfItemName
        ? `${buttonLabel} / ${ctx.scarfItemName}を使用`
        : `${buttonLabel} / すばやさ補正アイテムなし`;
      button.append(createRefreshIcon(), label);
      button.addEventListener('click', () => {
        void handleApply(selection, button);
      });
      wrap.append(button);
    }

    el.appendChild(wrap);
  }

  async function handleApply(selection: SpeedTargetSelection, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    clearError();

    const itemName = selection.usesScarf ? ctx.scarfItemName : currentItem;
    const validated = validateSpeedChartApplyPayload({ nature: selection.nature, evSpe: selection.evSpe, itemName });
    if (!validated.ok) {
      // UI改修(2026-08-06): 内部の検証理由は画面へ露出せず、操作単位のエラーに統一する。
      showError('ステータスを更新できませんでした');
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
        await res.json().catch(() => null);
        // R-10: 保存失敗時は ← 現在 マーカーを動かさず(=状態を更新しない)、
        // クリックした候補を再クリックできる状態に戻す(button.disabled = false)。
        showError('ステータスを更新できませんでした');
        button.disabled = false;
        return;
      }
    } catch {
      showError('ステータスを更新できませんでした');
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
      renderedCells.set(rowValue, el);
      el.className = 'speed-chart-owned';
      paintCell(rowValue, el);
      return el;
    },
  };
}
