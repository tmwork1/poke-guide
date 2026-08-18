// すばやさ早見表(/speed-chart)「この個体」セルのレンダラ。
//
// R-13: 「この個体」列は独立したカラムではなく、ChartTable側(chart-table.ts)が
// 1行ぶん組み立てるたびに呼び出す「セルのレンダラ」。このファイルの責務(ファイル分割表どおり):
//   - その個体で実現可能なすばやさ実数値の列挙(素の性格3種×S努力値0〜32×持ち物2種の直積。
//     ランク上昇は含めない。P1確定仕様)
//   - 「この個体」セルの3状態描画(R-7: 現在[クリック不可] / [性格 努力値N]ボタン / −)
//   - クリック時の PUT /api/owned-pokemon/:id(R-1: 全項目上書き契約を厳守。埋め込まれた
//     レコード全体をspreadしてから nature/evs/item_name の3項目だけ上書きする)
//   - 保存失敗時の表示(R-10: エラー文言・現在マーカーを動かさない・候補を再クリック可能に戻す)
//   - 調整ボタンが提案する性格の、現在の性格に対する「近さ」の調整(selectMinimalCostSpeedOption()
//     が返す性格をこのファイル側で置き換える。詳細は pickReplacementNature()のコメント参照)
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
import { championSpriteUrl, officialArtworkUrl } from '../pokemon-master-data';
import { itemIconUrl } from '../sprite-urls';

export const OWNED_CURRENT_VALUE_EVENT = 'speed-chart:owned-current-changed';

export interface OwnedCurrentValueEventDetail {
  value: number;
  /** ランク操作による変更時だけ表を再描画して移動する。 */
  navigate?: boolean;
}

// 「個体が到達可能な実数値の集合」はこのモジュールが所有し、CustomEventで
// chart-table.tsへ一方向に通知する(panel→table)。chart-table.tsはこれを受けて
// 行の表示/非表示を切り替えるだけで、combos自体(このモジュールの内部状態)には触れない。
export const OWNED_REACHABLE_VALUES_EVENT = 'speed-chart:owned-reachable-values-changed';

export interface OwnedReachableValuesEventDetail {
  values: number[];
}

export interface OwnedPanelContext {
  /** index.astro が <script type="application/json"> で埋め込んだレコード全体(R-1)。 */
  ownedRecord: OwnedPokemonRecord;
  baseSpeed: number;
  /**
   * こだわりスカーフの倍率補正。メガ種族またはそのレギュレーションでスカーフが
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
   * フォルム名がマスターデータに見つからない等でnullのときはアイコン段は表示しない。
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
const SUMMARY_RAW_VALUE_ID = 'speed-chart-owned-summary-raw-value';
const ERROR_BANNER_ID = 'speed-chart-owned-error';

const NATURE_EFFECT_MODIFIER: Record<'up' | 'neutral' | 'down', number> = {
  up: 1.1,
  neutral: 1.0,
  down: 0.9,
};

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

  const body = document.createElementNS(ns, 'path');
  body.setAttribute('d', 'M21 12a9 9 0 1 1-2.64-6.36');
  svg.appendChild(body);

  const tip = document.createElementNS(ns, 'path');
  tip.setAttribute('d', 'M21 3v6h-6');
  svg.appendChild(tip);

  return svg;
}

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

  function updateSummary(): void {
    // 1段目: アイコン。spriteImageIdが無い個体(マスターデータに未登録のフォルム等)は
    // hiddenのままにする(pitfalls.md: 画像が無いときは要素ごと隠す)。
    const spriteEl = document.getElementById(SUMMARY_SPRITE_ID) as HTMLImageElement | null;
    if (spriteEl) {
      if (ctx.spriteImageId != null) {
        spriteEl.src = championSpriteUrl(ctx.spriteImageId);
        spriteEl.onerror = () => {
          spriteEl.onerror = null;
          spriteEl.src = officialArtworkUrl(ctx.spriteImageId!);
        };
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
        const text = document.createElement('span');
        text.textContent = currentItem;
        itemEl.title = currentItem;
        itemEl.appendChild(text);
        const image = document.createElement('img');
        image.alt = '';
        image.src = itemIconUrl(currentItem);
        image.addEventListener('error', () => image.remove(), { once: true });
        itemEl.prepend(image);
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
    if (evsEl) evsEl.textContent = `努力値 ${currentEvs[5] ?? 0}`;
    const valueEl = document.getElementById(SUMMARY_VALUE_ID);
    if (valueEl) {
      const embedded = document.querySelector<HTMLElement>('.speed-chart-table')?.dataset.embedded === 'true';
      valueEl.textContent = embedded ? String(currentValue) : `すばやさ ${currentValue}`;
    }
    const rawValueEl = document.getElementById(SUMMARY_RAW_VALUE_ID);
    if (rawValueEl) {
      const effect = getNatureSpeedEffect(currentNature);
      rawValueEl.textContent = String(calcOtherStat(50, ctx.baseSpeed, 31, currentEvs[5] ?? 0, NATURE_EFFECT_MODIFIER[effect]));
    }
  }

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
        detail: { values: [...combos.map((combo) => combo.value), currentValue] },
      }),
    );
  }

  function paintCell(rowValue: number, el: HTMLElement): void {
    el.replaceChildren();
    el.classList.remove('is-current', 'is-reachable', 'is-unreachable');

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
      const buttonParts = [selection.nature, `努力値 ${selection.evSpe}`];
      const buttonLabel = buttonParts.join(' / ');
      const label = document.createElement('span');
      label.className = 'speed-chart-apply-label';
      const natureLabel = document.createElement('span');
      natureLabel.textContent = selection.nature;
      const evLabel = document.createElement('span');
      evLabel.textContent = String(selection.evSpe);
      label.append(natureLabel, evLabel);
      button.title = selection.usesScarf && ctx.scarfItemName
        ? `${buttonLabel} / ${ctx.scarfItemName}を使用`
        : `${buttonLabel} / すばやさ補正アイテムなし`;
      button.append(label);
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

    // 通常表示では従来どおり個体編集画面へ戻る。個体編集モーダル内(iframe)では親へ
    // 保存完了を通知して親画面を更新させる。iframe自身を /box/:id へ遷移させない。
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'speed-chart:applied', ownedId: ctx.ownedRecord.id }, window.location.origin);
      return;
    }
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
