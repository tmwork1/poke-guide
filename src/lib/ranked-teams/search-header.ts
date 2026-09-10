import type { RankedTeam } from '../ranked-teams';
import { renderTeamMateSlots, type TeamMateCardPokemon } from '../team-mate-card';
import { renderTopBuildCard, type RenderTopBuildCardOptions } from './card';

export type RankedTeamsDisplayMode = 'expanded' | 'compressed';

export const RANKED_TEAMS_DISPLAY_DENSITY_STORAGE_KEY = 'poke-guide:top-builds-display-density';
export const DENSITY_ICON_EXPANDED = `<svg class="density-toggle-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="5" height="5" rx="1"/><rect x="10" y="4" width="5" height="5" rx="1"/><rect x="18" y="4" width="5" height="5" rx="1"/><rect x="2" y="12" width="5" height="5" rx="1"/><rect x="10" y="12" width="5" height="5" rx="1"/><rect x="18" y="12" width="5" height="5" rx="1"/></svg>`;
export const DENSITY_ICON_COMPRESSED = `<svg class="density-toggle-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="10" width="5" height="5" rx="1"/><rect x="10" y="10" width="5" height="5" rx="1"/><rect x="18" y="10" width="5" height="5" rx="1"/></svg>`;

interface SetupRankedTeamsSearchHeaderOptions {
	idPrefix: string;
	onSearchChange?: (value: string) => void;
	onDensityChange?: (mode: RankedTeamsDisplayMode) => void;
	onSeasonChange?: (season: string) => void;
}

export interface RankedTeamsSearchHeaderController {
	getSearchValue(): string;
	getDisplayMode(): RankedTeamsDisplayMode;
	getSeason(): string;
}

function requiredElement<T extends HTMLElement>(id: string): T {
	const element = document.getElementById(id);
	if (!element) throw new Error(`要素が見つかりません: #${id}`);
	return element as T;
}

function loadDisplayMode(): RankedTeamsDisplayMode {
	try {
		return window.localStorage.getItem(RANKED_TEAMS_DISPLAY_DENSITY_STORAGE_KEY) === 'compressed'
			? 'compressed'
			: 'expanded';
	} catch {
		// localStorage が利用できない環境では、従来どおり展開表示を既定にする。
		return 'expanded';
	}
}

function saveDisplayMode(mode: RankedTeamsDisplayMode): void {
	try {
		window.localStorage.setItem(RANKED_TEAMS_DISPLAY_DENSITY_STORAGE_KEY, mode);
	} catch {
		// 保存できなくても、現在開いているページでの切り替えは維持する。
	}
}

export function setupRankedTeamsSearchHeader({
	idPrefix,
	onSearchChange,
	onDensityChange,
	onSeasonChange,
}: SetupRankedTeamsSearchHeaderOptions): RankedTeamsSearchHeaderController {
	const search = requiredElement<HTMLInputElement>(`${idPrefix}-search`);
	const season = requiredElement<HTMLSelectElement>(`${idPrefix}-season`);
	const densityToggle = requiredElement<HTMLButtonElement>(`${idPrefix}-display-density-toggle`);
	let displayMode = loadDisplayMode();
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;

	const updateDensityToggleUi = (): void => {
		densityToggle.dataset.mode = displayMode;
		densityToggle.innerHTML = displayMode === 'expanded' ? DENSITY_ICON_EXPANDED : DENSITY_ICON_COMPRESSED;
		densityToggle.setAttribute(
			'aria-label',
			displayMode === 'expanded' ? '圧縮表示に切り替える' : '展開表示に切り替える',
		);
	};

	search.addEventListener('input', () => {
		if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
		debounceTimer = window.setTimeout(() => onSearchChange?.(search.value), 150);
	});
	densityToggle.addEventListener('click', () => {
		displayMode = displayMode === 'expanded' ? 'compressed' : 'expanded';
		saveDisplayMode(displayMode);
		updateDensityToggleUi();
		onDensityChange?.(displayMode);
	});
	season.addEventListener('change', () => onSeasonChange?.(season.value));
	updateDensityToggleUi();

	return {
		getSearchValue: () => search.value,
		getDisplayMode: () => displayMode,
		getSeason: () => season.value,
	};
}

interface CreateRankedTeamCardRendererOptions {
	getDisplayMode: () => RankedTeamsDisplayMode;
	onCardExpand: () => void;
}

export interface RankedTeamCardRenderer {
	renderCard(team: RankedTeam, options?: Pick<RenderTopBuildCardOptions, 'highlightSlot' | 'highlightSlots'>): HTMLElement;
	resetTapExpandedTeams(): void;
}

/** 3画面で共有する、圧縮カードとカード単体のタップ展開を含む描画器。 */
export function createRankedTeamCardRenderer({
	getDisplayMode,
	onCardExpand,
}: CreateRankedTeamCardRendererOptions): RankedTeamCardRenderer {
	const tapExpandedTeamIds = new Set<string>();

	return {
		renderCard(team, options = {}) {
			const isCompressed = getDisplayMode() === 'compressed' && !tapExpandedTeamIds.has(team.id);
			const card = renderTopBuildCard(team, {
				...options,
				renderMembers: isCompressed
					? (container) => {
							container.className = 'team-mate-grid';
							const membersBySlot = new Map<number, TeamMateCardPokemon>(
								team.members.map((member) => [
									member.slot,
									{ species_name: member.speciesKey ?? member.speciesName, item_name: member.itemName },
								]),
							);
							renderTeamMateSlots({
								root: container,
								membersBySlot,
								displayName: (pokemon) => pokemon.species_name || 'ポケモン',
							});
						}
					: undefined,
			});
			if (isCompressed) {
				const highlightSlots = new Set(options.highlightSlots ?? []);
				if (options.highlightSlot !== undefined) highlightSlots.add(options.highlightSlot);
				for (const memberCard of card.querySelectorAll<HTMLElement>('.team-mate-card[data-slot]')) {
					if (highlightSlots.has(Number(memberCard.dataset.slot))) {
						memberCard.classList.add('card-pokemon--similar');
					}
				}
			}
			if (isCompressed) {
				card.addEventListener('click', (event) => {
					if (event.target instanceof Element && event.target.closest('.card-team-article-link')) return;
					tapExpandedTeamIds.add(team.id);
					onCardExpand();
				});
			}
			return card;
		},
		resetTapExpandedTeams() {
			tapExpandedTeamIds.clear();
		},
	};
}
