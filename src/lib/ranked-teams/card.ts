import type { RankedTeam } from '../ranked-teams';
import { officialArtworkUrl } from '../pokemon-master-data';
import { itemIconUrl, typeIconUrl } from '../sprite-urls';

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderRankedTeamCard(
  team: RankedTeam,
  imageIdMap: Map<string, number>,
  itemSpriteMap: Map<string, string>,
  moveTypeMap: Map<string, string>,
): HTMLElement {
  const card = element('article', 'card card-ranked-team');

  const header = element('header', 'ranked-team-header');
  header.append(element('span', 'badge tnum', `${team.rank}位`));
  if (team.rating !== null) {
    // 順位と同じ指標群として隣接させつつ、控えめなバッジで役割を区別する。
    header.append(element('span', 'badge badge-muted ranked-team-rating tnum', `レート ${Math.round(team.rating)}`));
  }
  if (team.trainerName) header.append(element('span', 'ranked-team-trainer', team.trainerName));
  if (team.articleUrl) {
    const linkGroup = element('span', 'ranked-team-article-group');
    const label = team.articleTitle ?? team.articleHost ?? '構築記事';
    const link = element('a', 'ranked-team-article-link');
    link.append(element('span', 'ranked-team-article-label', label));
    const externalIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    externalIcon.setAttribute('class', 'ranked-team-article-icon');
    externalIcon.setAttribute('viewBox', '0 0 24 24');
    externalIcon.setAttribute('fill', 'none');
    externalIcon.setAttribute('stroke', 'currentColor');
    externalIcon.setAttribute('stroke-width', '2');
    externalIcon.setAttribute('stroke-linecap', 'round');
    externalIcon.setAttribute('stroke-linejoin', 'round');
    externalIcon.setAttribute('aria-hidden', 'true');
    const externalBox = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    externalBox.setAttribute('d', 'M15 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-9');
    const externalArrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    externalArrow.setAttribute('d', 'M13 3h8v8M10 14 21 3');
    externalIcon.append(externalBox, externalArrow);
    link.append(externalIcon);
    link.href = team.articleUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = label;
    linkGroup.append(link);
    // article_title が NULL のとき label は article_host にフォールバックする(上の label 参照)。
    // そのままホストバッジも出すと「www.youtube.com ↗ www.youtube.com」のように同じ文字列が
    // 2回並ぶ(P5の実測で M-3 6位のカードに発生)。同一なら遷移先の情報量が増えないので出さない。
    if (team.articleHost && label !== team.articleHost) {
      linkGroup.append(element('span', 'badge badge-muted ranked-team-host', team.articleHost));
    }
    header.append(linkGroup);
  }
  card.append(header);

  const body = element('div', 'ranked-team-body');
  const memberGrid = element('div', 'ranked-team-members');
  const bySlot = new Map(team.members.map((member) => [member.slot, member]));
  for (let slot = 1; slot <= 6; slot += 1) {
    const member = bySlot.get(slot);
    const thumb = element('div', `ranked-team-thumb${member ? '' : ' is-empty'}`);
    if (!member) {
      thumb.append(element('span', 'ranked-team-empty-slot tnum', String(slot)));
      memberGrid.append(thumb);
      continue;
    }

    const displayName = member.speciesKey ?? member.speciesName;
    thumb.title = displayName;
    const imageId = imageIdMap.get(displayName) ?? imageIdMap.get(member.speciesName);
    const imageWrap = element('span', 'ranked-team-image-wrap');
    if (imageId !== undefined) {
      const image = element('img', 'ranked-team-pokemon-image');
      image.src = officialArtworkUrl(imageId);
      image.alt = displayName;
      image.loading = 'lazy';
      image.decoding = 'async';
      imageWrap.append(image);
    } else {
      imageWrap.append(element('span', 'ranked-team-image-fallback', displayName.charAt(0) || '?'));
    }
    if (member.itemName) {
      const spritePath = itemSpriteMap.get(member.itemName);
      if (spritePath) {
        const badge = element('span', 'ranked-team-item-badge');
        badge.title = member.itemName;
        const itemImage = element('img');
        itemImage.src = itemIconUrl(spritePath);
        itemImage.alt = member.itemName;
        itemImage.loading = 'lazy';
        badge.append(itemImage);
        imageWrap.append(badge);
      }
    }
    thumb.append(imageWrap);

    thumb.append(element('span', 'ranked-team-species-name', displayName));
    if (member.ability) {
      const ability = element('span', 'ranked-team-ability', member.ability);
      ability.title = member.ability;
      thumb.append(ability);
    }
    if (member.moveNames.length > 0) {
      const moveList = element('div', 'ranked-team-moves');
      // 実機の技枠に合わせ、入力データが過剰でもカードには先頭4件だけを表示する。
      for (const moveName of member.moveNames.slice(0, 4)) {
        const move = element('span', 'ranked-team-move');
        const moveType = moveTypeMap.get(moveName);
        const iconUrl = moveType ? typeIconUrl(moveType) : null;
        if (iconUrl) {
          const icon = element('img', 'ranked-team-move-type');
          icon.src = iconUrl;
          icon.alt = moveType ?? '';
          icon.loading = 'lazy';
          move.append(icon);
        }
        const name = element('span', 'ranked-team-move-name', moveName);
        name.title = moveName;
        move.append(name);
        moveList.append(move);
      }
      thumb.append(moveList);
    }
    memberGrid.append(thumb);
  }
  body.append(memberGrid);

  const details = element('dl', 'ranked-team-details');
  for (const heading of ['選出パターン', '立ち回り']) {
    const row = element('div', 'ranked-team-detail-row');
    row.append(element('dt', undefined, heading));
    const value = element('dd');
    value.append(element('span', 'badge badge-muted', '準備中'));
    row.append(value);
    details.append(row);
  }
  body.append(details);
  card.append(body);
  return card;
}
