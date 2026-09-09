// バトルデータカードをSSRとクライアントで同じ形にするHTMLレンダラー。
// OP.GG由来の表示名も含むため、DOMへ渡す前にここで必ずエスケープする。
import {
  evSpreadLabel,
  imageIdByName,
  moveTypeByName,
  natureModifierLabel,
  natureModifierStats,
  usageRateLabel,
  type SingleFormatData,
} from './battle-data-card';
import { championSpriteIconUrl, championSpriteUrl, officialArtworkUrl } from './pokemon-master-data';
import { itemIconUrl } from './sprite-urls';
import { DEFAULT_TYPE_COLOR, TYPE_COLORS } from './type-colors';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!);
}

function emptyOrList(rows: string[]): string {
  return rows.length ? `<ul class="trend-rank-list">${rows.join('')}</ul>` : '<strong>データなし</strong>';
}

/** /data の遅延挿入と BattleDataCard.astro のSSRで共有するカード本体。 */
export function renderBattleDataCardHtml(single: SingleFormatData | null | undefined): string {
  const abilities = single?.abilities ?? [];
  const natures = single?.natures ?? [];
  const items = single?.items ?? [];
  const moves = single?.moves ?? [];
  const evs = single?.evs ?? [];
  const teammates = single?.teammates ?? [];

  const abilitiesHtml = emptyOrList(abilities.map((row) =>
    `<li class="trend-rank-row trend-rank-row--text2"><span class="trend-rank-name">${escapeHtml(row.name)}</span><span class="trend-rank-rate">${escapeHtml(usageRateLabel(row.usageRate))}</span></li>`,
  ));
  const naturesHtml = emptyOrList(natures.map((row) => {
    const modifier = natureModifierStats(row.name);
    const modifierHtml = modifier
      ? `<span class="trend-nature-modifier" aria-label="${escapeHtml(natureModifierLabel(row.name))}"><span class="trend-nature-modifier-up">${escapeHtml(modifier.up)}↑</span> <span class="trend-nature-modifier-down">${escapeHtml(modifier.down)}↓</span></span>`
      : '<span class="trend-nature-modifier"></span>';
    return `<li class="trend-rank-row trend-rank-row--nature3"><span class="trend-rank-name">${escapeHtml(row.name)}</span>${modifierHtml}<span class="trend-rank-rate">${escapeHtml(usageRateLabel(row.usageRate))}</span></li>`;
  }));
  const itemIconOnerror = "this.closest('.trend-rank-row').classList.replace('trend-rank-row--icon3','trend-rank-row--text2');this.parentElement.remove()";
  const itemsHtml = emptyOrList(items.map((row) =>
    `<li class="trend-rank-row trend-rank-row--icon3"><span class="trend-rank-icon"><img src="${escapeHtml(itemIconUrl(row.name))}" onerror="${escapeHtml(itemIconOnerror)}" alt="" loading="lazy"></span><span class="trend-rank-name">${escapeHtml(row.name)}</span><span class="trend-rank-rate">${escapeHtml(usageRateLabel(row.usageRate))}</span></li>`,
  ));
  const movesHtml = emptyOrList(moves.map((row) => {
    const type = moveTypeByName(row.name);
    const typeHtml = type
      ? `<span class="trend-rank-type-bar" style="--trend-move-type-color: ${escapeHtml(TYPE_COLORS[type] ?? DEFAULT_TYPE_COLOR)};" title="${escapeHtml(type)}" aria-label="${escapeHtml(`${type}タイプ`)}"></span>`
      : '';
    return `<li class="trend-rank-row ${type ? 'trend-rank-row--type3' : 'trend-rank-row--text2'}">${typeHtml}<span class="trend-rank-name">${escapeHtml(row.name)}</span><span class="trend-rank-rate">${escapeHtml(usageRateLabel(row.usageRate))}</span></li>`;
  }));
  const evsHtml = emptyOrList(evs.map((row) =>
    `<li class="trend-rank-row trend-rank-row--text2"><span class="trend-rank-name">${escapeHtml(evSpreadLabel(row.values))}</span><span class="trend-rank-rate">${escapeHtml(usageRateLabel(row.usageRate))}</span></li>`,
  ));
  const teammatesHtml = emptyOrList(teammates.map((row, index) => {
    const imageId = imageIdByName(row.name);
    const imageHtml = imageId === null ? '' : (() => {
      const onerror = `this.onerror=()=>{this.onerror=()=>{this.onerror=null;this.src='${officialArtworkUrl(imageId)}';};this.src='${championSpriteUrl(imageId)}';};`;
      return `<span class="trend-rank-icon"><img class="trend-rank-icon--pokemon" src="${escapeHtml(championSpriteIconUrl(imageId))}" onerror="${escapeHtml(onerror)}" alt="" loading="lazy"></span>`;
    })();
    return `<li class="trend-rank-row ${imageId !== null ? 'trend-rank-row--rank-icon3' : 'trend-rank-row--rank-name2'}"><span class="trend-rank-order" aria-label="${index + 1}位">${index + 1}</span>${imageHtml}<span class="trend-rank-name">${escapeHtml(row.name)}</span></li>`;
  }));

  return `<div class="trend-detail-card" data-battle-data-card>
  <div class="trend-detail-cell">
    <span>特性</span>
    <div class="trend-cell-body">${abilitiesHtml}</div>
  </div>
  <div class="trend-detail-cell">
    <span>性格</span>
    <div class="trend-cell-body">${naturesHtml}</div>
  </div>
  <div class="trend-detail-cell">
    <span>もちもの</span>
    <div class="trend-cell-body">${itemsHtml}</div>
  </div>
  <div class="trend-detail-cell">
    <span>わざ</span>
    <div class="trend-cell-body">${movesHtml}</div>
  </div>
  <div class="trend-detail-cell">
    <span>努力値</span>
    <div class="trend-cell-body">${evsHtml}</div>
  </div>
  <div class="trend-detail-cell">
    <span>同時採用</span>
    <div class="trend-cell-body">${teammatesHtml}</div>
  </div>
</div>`;
}
