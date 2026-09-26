import type { RankedTeam } from '../ranked-teams';
import { renderTeamCard } from '../team-card';
import { getAppBandRect } from '../app-band';

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
  // 箱の右上を大きく切り欠き、矢印(線・矢頭)が箱の線に触れないようにする。
  box.setAttribute('d', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6');
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrow.setAttribute('d', 'M15 3h6v6M10 14 21 3');
  icon.append(box, arrow);
  return icon;
}

export interface RenderTopBuildCardOptions {
  highlightSlot?: number;
  /** Highlight multiple members using the shared top-build match treatment. */
  highlightSlots?: readonly number[];
  /** 指定時は既定のbox-cardグリッドの代わりにこれを呼ぶ(/data 上位チームの圧縮表示)。 */
  renderMembers?: (container: HTMLElement) => void;
}

const STAT_LABELS = ['H', 'A', 'B', 'C', 'D', 'S'] as const;
const MEMBER_POPOVER_VIEWPORT_GUTTER = 8;
const MEMBER_POPOVER_GAP = 4;
let activeMemberPopover: HTMLElement | null = null;
let activeMemberPopoverCard: HTMLElement | null = null;
let isMemberPopoverDismissalBound = false;

function closeActiveMemberPopover(): void {
  activeMemberPopover?.remove();
  activeMemberPopover = null;
  activeMemberPopoverCard = null;
}

function bindMemberPopoverDismissal(): void {
  if (isMemberPopoverDismissalBound) return;
  isMemberPopoverDismissalBound = true;
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('.card-team-member-popover')) {
      closeActiveMemberPopover();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeActiveMemberPopover();
  });
}

function rankedMemberEvsLabel(evs: number[] | null): string {
  if (!evs) return '不明';
  return STAT_LABELS
    .map((label, index) => [label, evs[index] ?? 0] as const)
    .filter(([, value]) => value !== 0)
    .map(([label, value]) => `${label}${value}`)
    .join(' ') || '不明';
}

export function renderTopBuildCard(team: RankedTeam, options: RenderTopBuildCardOptions = {}): HTMLElement {
  bindMemberPopoverDismissal();
  const membersBySlot = new Map(team.members.map((member) => [member.slot, member]));
  const trainerName = team.trainerName ?? team.articleHost ?? 'トレーナー不明';
  const card = renderTeamCard({
    name: trainerName,
    nameTitle: trainerName,
    cornerAction: team.articleUrl
      ? {
          type: 'link',
          href: team.articleUrl,
          label: team.articleTitle ?? team.articleHost ?? '構築記事',
          title: team.articleTitle ?? team.articleHost ?? '構築記事',
          content: createExternalLinkIcon(),
        }
      : undefined,
    badges: [
      { className: 'badge tnum', text: team.season },
    ],
    plainMeta: [
      { className: 'card-team-rank-text tnum', text: `${team.rank}位` },
      ...(team.rating !== null
        ? [{
            className: 'card-team-rating-text tnum',
            text: String(Math.round(team.rating)),
            title: `レート ${team.rating}`,
          }]
        : []),
    ],
    headerVariant: 'inline',
    membersBySlot,
    renderMembers: options.renderMembers,
    toCardContent: (member) => {
      const displayName = member.speciesKey ?? member.speciesName;
      return {
        pokemon: {
          species_name: displayName,
          level: 50,
          nature: member.nature,
          ability_name: member.ability,
          item_name: member.itemName,
          tera_type: null,
          evs: member.evs ?? [0, 0, 0, 0, 0, 0],
          ivs: [31, 31, 31, 31, 31, 31],
          move_names: member.moveNames,
          memo: null,
        },
        displayName,
        ariaLabel: displayName,
      };
    },
  });

  const highlightSlots = new Set(options.highlightSlots ?? []);
  if (options.highlightSlot !== undefined) highlightSlots.add(options.highlightSlot);
  const memberCards = card.querySelectorAll<HTMLElement>('.card-pokemon');
  const members = [...team.members].sort((a, b) => a.slot - b.slot);
  memberCards.forEach((memberCard, index) => {
    const member = members[index];
    if (!member) return;
    if (highlightSlots.has(member.slot)) memberCard.classList.add('card-pokemon--similar');
    memberCard.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (activeMemberPopoverCard === memberCard) {
        closeActiveMemberPopover();
        return;
      }
      closeActiveMemberPopover();
      const popover = element('div', 'card-team-member-popover');
      popover.setAttribute('role', 'dialog');
      popover.setAttribute('aria-label', `${member.speciesName}の育成情報`);
      for (const value of [
        member.ability || '不明',
        member.nature || '不明',
        rankedMemberEvsLabel(member.evs),
      ]) {
        const row = element('p', 'card-team-member-popover-row');
        row.textContent = value;
        popover.append(row);
      }
      popover.style.position = 'fixed';
      document.body.append(popover);

      const memberCardRect = memberCard.getBoundingClientRect();
      const popoverRect = popover.getBoundingClientRect();
      const appBand = getAppBandRect();
      const maxLeft = Math.max(appBand.left + MEMBER_POPOVER_VIEWPORT_GUTTER, appBand.right - popoverRect.width - MEMBER_POPOVER_VIEWPORT_GUTTER);
      const maxTop = Math.max(MEMBER_POPOVER_VIEWPORT_GUTTER, window.innerHeight - popoverRect.height - MEMBER_POPOVER_VIEWPORT_GUTTER);
      popover.style.left = `${Math.min(Math.max(memberCardRect.left, appBand.left + MEMBER_POPOVER_VIEWPORT_GUTTER), maxLeft)}px`;
      popover.style.top = `${Math.min(Math.max(memberCardRect.bottom + MEMBER_POPOVER_GAP, MEMBER_POPOVER_VIEWPORT_GUTTER), maxTop)}px`;
      activeMemberPopover = popover;
      activeMemberPopoverCard = memberCard;
    });
  });

  return card;
}
