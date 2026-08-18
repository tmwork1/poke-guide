import type { RankedTeam } from '../ranked-teams';
import { championSpriteUrl, officialArtworkUrl } from '../pokemon-master-data';
import { itemIconUrl, typeIconUrl } from '../sprite-urls';
import { renderTeamCard } from '../team-card';

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

/** 外部リンクを示す「箱+矢印」アイコン。上位構築カードと /ranked-teams のカードで共有する。 */
function createExternalLinkIcon(className?: string): SVGSVGElement {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (className) icon.setAttribute('class', className);
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.setAttribute('aria-hidden', 'true');
  const box = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  box.setAttribute('d', 'M15 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-9');
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrow.setAttribute('d', 'M13 3h8v8M10 14 21 3');
  icon.append(box, arrow);
  return icon;
}

function buildRankedTeamHeader(team: RankedTeam): HTMLElement {
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
    link.append(createExternalLinkIcon('ranked-team-article-icon'));
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
  return header;
}

export function renderRankedTeamCard(
  team: RankedTeam,
  imageIdMap: Map<string, number>,
  moveTypeMap: Map<string, string>,
): HTMLElement {
  const card = element('article', 'card card-ranked-team');
  card.append(buildRankedTeamHeader(team));

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
      let triedArtworkFallback = false;
      image.onerror = () => {
        if (!triedArtworkFallback) {
          triedArtworkFallback = true;
          image.src = officialArtworkUrl(imageId);
          return;
        }
        image.remove();
        imageWrap.append(element('span', 'ranked-team-image-fallback', displayName.charAt(0) || '?'));
      };
      image.src = championSpriteUrl(imageId);
      image.alt = displayName;
      image.loading = 'lazy';
      image.decoding = 'async';
      imageWrap.append(image);
    } else {
      imageWrap.append(element('span', 'ranked-team-image-fallback', displayName.charAt(0) || '?'));
    }
    if (member.itemName) {
      const badge = element('span', 'ranked-team-item-badge');
      badge.title = member.itemName;
      const itemImage = element('img');
      itemImage.src = itemIconUrl(member.itemName);
      itemImage.alt = member.itemName;
      itemImage.loading = 'lazy';
      itemImage.addEventListener('error', () => badge.remove(), { once: true });
      badge.append(itemImage);
      imageWrap.append(badge);
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

export function renderTopBuildCard(team: RankedTeam): HTMLElement {
  const membersBySlot = new Map(team.members.map((member) => [member.slot, member]));
  const trainerName = team.trainerName ?? team.articleHost ?? 'トレーナー不明';
  const articleLabel = team.articleTitle ?? team.articleHost ?? '構築記事';
  return renderTeamCard({
    name: trainerName,
    nameTitle: trainerName,
    cornerAction: team.articleUrl
      ? {
          type: 'link',
          href: team.articleUrl,
          label: articleLabel,
          title: articleLabel,
          // 18pxの寸法は共用カード側のアイコンスロットCSSで決める。
          content: createExternalLinkIcon(),
        }
      : undefined,
    badges: [
      { className: 'badge card-team-rank-badge tnum', text: `${team.rank}位` },
      ...(team.rating !== null
        ? [{
            className: 'badge card-team-rating-badge tnum',
            text: String(Math.round(team.rating)),
            title: `レート ${team.rating}`,
          }]
        : []),
    ],
    membersBySlot,
    toCardContent: (member) => {
      const displayName = member.speciesKey ?? member.speciesName;
      return {
        pokemon: {
          species_name: displayName,
          level: 50,
          nature: null,
          ability_name: member.ability,
          item_name: member.itemName,
          tera_type: null,
          evs: [0, 0, 0, 0, 0, 0],
          ivs: [31, 31, 31, 31, 31, 31],
          move_names: member.moveNames,
          memo: null,
        },
        displayName,
        ariaLabel: displayName,
      };
    },
  });
}
