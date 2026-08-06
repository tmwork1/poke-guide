import type { RankedTeam } from '../ranked-teams';
import { spriteUrl } from '../pokemon-master-data';
import { itemIconUrl } from '../sprite-urls';

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
): HTMLElement {
  const card = element('article', 'card card-ranked-team');

  const header = element('header', 'ranked-team-header');
  header.append(element('span', 'badge tnum', `${team.rank}位`));
  if (team.trainerName) header.append(element('span', 'ranked-team-trainer', team.trainerName));
  if (team.rating !== null) {
    header.append(element('span', 'ranked-team-rating tnum', `レート ${Math.round(team.rating)}`));
  }
  if (team.articleUrl) {
    const linkGroup = element('span', 'ranked-team-article-group');
    const label = team.articleTitle ?? team.articleHost ?? '構築記事';
    const link = element('a', 'ranked-team-article-link', `${label} ↗`);
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
    if (imageId !== undefined) {
      const image = element('img', 'ranked-team-pokemon-image');
      image.src = spriteUrl(imageId);
      image.alt = displayName;
      image.loading = 'lazy';
      image.decoding = 'async';
      thumb.append(image);
    } else {
      thumb.append(element('span', 'ranked-team-image-fallback', displayName.charAt(0) || '?'));
    }

    thumb.append(element('span', 'ranked-team-species-name', displayName));
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
        thumb.append(badge);
      }
    }
    memberGrid.append(thumb);
  }
  body.append(memberGrid);

  const details = element('dl', 'ranked-team-details');
  for (const heading of ['選出パターン', '立ち回り', '構築の改善点']) {
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
