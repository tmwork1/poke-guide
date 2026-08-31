import {
	championSpriteUrl,
	loadImageIdMap,
	loadMoveDetailMap,
	loadMultiHitMoveMap,
	loadTypesMap,
	officialArtworkUrl,
} from './pokemon-master-data';
import {
	calcMaxDamageMatrix,
	initEngine,
	isEngineFatal,
	registerOfflineCache,
	resetEngine,
	type PokemonSpec,
} from './pyodide-engine';
import {
	MATCHUP_TOP_N,
	OPPONENT_EVS,
	OPPONENT_NATURE,
	averageRatio,
	damageRatio,
	matchupDisadvantageScore,
	pickOpponentAttackMoves,
	pickTeamAttackMoves,
	scoreToOpacities,
	type MatchupDirection,
	type PopularMoveOption,
} from './team-matchup';
import { DEFAULT_TYPE_COLOR, TYPE_COLORS } from './type-colors';

/** 相性計算に必要な、所有ポケモンの最小限の情報。 */
export interface MatchupPanelMember {
	id: string;
	species_name: string;
	level?: number | null;
	nature?: string | null;
	ability_name?: string | null;
	item_name?: string | null;
	tera_type?: string | null;
	move_names?: readonly (string | null | undefined)[] | null;
	evs?: number[] | null;
	ivs?: number[] | null;
}

export interface MatchupTarget {
	speciesName: string;
	dexNo: number | null;
	usageTeams: number;
	totalTeams: number;
	moves: PopularMoveOption[];
}

interface MatchupScoreCacheEntry {
	attack: (number | null)[];
	defense: (number | null)[];
}

let matchupTargetsPromise: Promise<MatchupTarget[]> | null = null;
let imageIdMapPromise: Promise<Map<string, number>> | null = null;

/** 使用率上位の相手一覧をページ内で一度だけ読み込み、失敗時は次回に再試行する。 */
export async function loadMatchupTargets(): Promise<MatchupTarget[]> {
	if (!matchupTargetsPromise) {
		matchupTargetsPromise = fetch(`/api/matchup-targets?limit=${MATCHUP_TOP_N}`, { credentials: 'same-origin' })
			.then(async (res) => {
				if (!res.ok) throw new Error(`相性チェックの対象取得に失敗しました (status=${res.status})`);
				const body = (await res.json()) as { data: MatchupTarget[] };
				return body.data ?? [];
			})
			.catch((err) => {
				matchupTargetsPromise = null;
				throw err;
			});
	}
	return matchupTargetsPromise;
}

/** 自チームの1体を jpoke に渡す仕様へ変換する。 */
export function matchupTeamSpec(member: MatchupPanelMember, moveNames: string[]): PokemonSpec {
	return {
		name: member.species_name,
		level: member.level ?? 50,
		nature: member.nature ?? 'まじめ',
		abilityName: member.ability_name ?? '',
		itemName: member.item_name ?? '',
		moveNames,
		teraType: member.tera_type ?? null,
		evs: member.evs ?? undefined,
		ivs: member.ivs ?? undefined,
	};
}

/** 相手ポケモンの基準個体(性格補正なし・H32振り)。 */
export function matchupOpponentSpec(target: MatchupTarget, moveNames: string[]): PokemonSpec {
	return {
		name: target.speciesName,
		level: 50,
		nature: OPPONENT_NATURE,
		moveNames,
		evs: [...OPPONENT_EVS],
		ivs: [31, 31, 31, 31, 31, 31],
	};
}

export async function computeMatchupScore(
	target: MatchupTarget,
	direction: MatchupDirection,
	teamAttackSpecs: PokemonSpec[],
	teamDefenseSpecs: PokemonSpec[],
	isAttackMove: (moveName: string) => boolean,
	moveHitCounts: Record<string, number>,
): Promise<{ score: number; memberRatios: number[] } | null> {
	if (direction === 'attack') {
		const result = await calcMaxDamageMatrix(teamAttackSpecs, [matchupOpponentSpec(target, [])], { moveHitCounts });
		const hp = result.defenderMaxHp[0];
		if (hp == null) return null;
		const memberRatios = teamAttackSpecs.map((_, i) => damageRatio(result.maxDamage[i]?.[0] ?? 0, hp));
		const rawScore = averageRatio(memberRatios);
		if (rawScore === null) return null;
		return { score: matchupDisadvantageScore(rawScore, 'attack'), memberRatios };
	}

	const opponentMoves = pickOpponentAttackMoves(target.moves, isAttackMove);
	if (opponentMoves.length === 0) return null;
	const result = await calcMaxDamageMatrix([matchupOpponentSpec(target, opponentMoves)], teamDefenseSpecs, {
		moveHitCounts,
	});
	const memberRatios = teamDefenseSpecs.map((_, i) => {
		const hp = result.defenderMaxHp[i];
		if (hp == null) return 0;
		return damageRatio(result.maxDamage[0]?.[i] ?? 0, hp);
	});
	return { score: averageRatio(memberRatios), memberRatios };
}

async function applySprite(imgEl: HTMLImageElement, fallbackEl: HTMLElement, name: string): Promise<void> {
	imageIdMapPromise ??= loadImageIdMap();
	const imageId = name ? (await imageIdMapPromise).get(name) : undefined;
	if (imageId == null) {
		imgEl.style.display = 'none';
		fallbackEl.style.display = 'flex';
		fallbackEl.textContent = name ? name.charAt(0) : '?';
		return;
	}
	let triedArtworkFallback = false;
	imgEl.onerror = () => {
		if (!triedArtworkFallback) {
			triedArtworkFallback = true;
			imgEl.src = officialArtworkUrl(imageId);
			return;
		}
		imgEl.style.display = 'none';
		fallbackEl.style.display = 'flex';
		fallbackEl.textContent = name.charAt(0);
	};
	imgEl.onload = () => {
		imgEl.style.display = '';
		fallbackEl.style.display = 'none';
	};
	imgEl.src = championSpriteUrl(imageId);
}

export interface MatchupPanelOptions {
	listElement: HTMLElement;
	statusElement: HTMLElement;
	getMembers: () => MatchupPanelMember[];
	emptyMembersMessage?: string;
}

export interface MatchupPanel {
	run(): Promise<void>;
	schedule(delay?: number): void;
}

/** 相性結果の取得、計算、進捗表示、カード描画をまとめたクライアント用パネル。 */
export function createMatchupPanel(options: MatchupPanelOptions): MatchupPanel {
	const { listElement, statusElement, getMembers } = options;
	let requestId = 0;
	let timer: number | undefined;
	const scoreCache = new Map<string, MatchupScoreCacheEntry>();
	let cardElements: HTMLLIElement[] = [];
	let activeMovePopover: HTMLElement | null = null;
	let activeMovePopoverCard: HTMLElement | null = null;

	function closeMovePopover(): void {
		activeMovePopover?.remove();
		activeMovePopoverCard?.setAttribute('aria-expanded', 'false');
		activeMovePopover = null;
		activeMovePopoverCard = null;
	}

	function openMovePopover(
		card: HTMLLIElement,
		target: MatchupTarget,
		moveNames: readonly string[],
		getMoveType: (moveName: string) => string | null,
	): void {
		if (activeMovePopoverCard === card) {
			closeMovePopover();
			return;
		}
		closeMovePopover();

		const popover = document.createElement('div');
		popover.className = 'team-matchup-move-popover';
		popover.setAttribute('role', 'dialog');
		popover.setAttribute('aria-label', `${target.speciesName}の相性計算で考慮した技`);
		const moves = document.createElement('ul');
		moves.className = 'team-matchup-move-popover__list';
		if (moveNames.length === 0) {
			const empty = document.createElement('li');
			empty.textContent = '考慮できる攻撃技なし';
			moves.append(empty);
		} else {
			for (const moveName of moveNames) {
				const item = document.createElement('li');
				const typeBar = document.createElement('span');
				typeBar.className = 'team-matchup-move-popover__type-bar';
				const moveType = getMoveType(moveName);
				typeBar.style.backgroundColor = TYPE_COLORS[moveType ?? ''] ?? DEFAULT_TYPE_COLOR;
				if (moveType) typeBar.title = moveType;
				const name = document.createElement('span');
				name.textContent = moveName;
				item.append(typeBar, name);
				moves.append(item);
			}
		}
		popover.append(moves);
		document.body.append(popover);

		const cardRect = card.getBoundingClientRect();
		const popoverRect = popover.getBoundingClientRect();
		const viewportGutter = 8;
		const showAbove = cardRect.top >= popoverRect.height + viewportGutter;
		const top = showAbove ? cardRect.top - popoverRect.height - 8 : cardRect.bottom + 8;
		const left = Math.min(
			Math.max(viewportGutter, cardRect.left + cardRect.width / 2 - popoverRect.width / 2),
			window.innerWidth - popoverRect.width - viewportGutter,
		);
		popover.style.top = `${top}px`;
		popover.style.left = `${left}px`;
		popover.dataset.placement = showAbove ? 'above' : 'below';
		card.setAttribute('aria-expanded', 'true');
		activeMovePopover = popover;
		activeMovePopoverCard = card;
	}

	function setStatus(message: string | null): void {
		if (message === null) {
			statusElement.hidden = true;
			statusElement.textContent = '';
		} else {
			statusElement.textContent = message;
			statusElement.hidden = false;
		}
	}

	function clearLists(): void {
		closeMovePopover();
		listElement.innerHTML = '';
		listElement.removeAttribute('aria-busy');
		cardElements = [];
	}

	function createMatchupCards(
		targets: MatchupTarget[],
		typesMap: Map<string, string[]>,
		isAttackMove: (moveName: string) => boolean,
		getMoveType: (moveName: string) => string | null,
	): void {
		clearLists();
		for (const target of targets) {
			const card = document.createElement('li');
			card.className = 'team-matchup-card';
			card.dataset.state = 'pending';
			card.tabIndex = 0;
			card.setAttribute('role', 'button');
			card.setAttribute('aria-haspopup', 'dialog');
			card.setAttribute('aria-expanded', 'false');
			card.setAttribute('aria-label', `${target.speciesName}の相性計算で考慮した技を表示`);
			const img = document.createElement('img');
			img.className = 'team-matchup-sprite-img';
			img.alt = '';
			const fallback = document.createElement('span');
			fallback.className = 'team-matchup-sprite-fallback';
			card.append(img, fallback);
			void applySprite(img, fallback, target.speciesName);
			const typeNames = (typesMap.get(target.speciesName) ?? []).join('/');
			card.title = typeNames ? `${target.speciesName}\n${typeNames}` : target.speciesName;
			card.addEventListener('click', (event) => {
				event.stopPropagation();
				openMovePopover(card, target, pickOpponentAttackMoves(target.moves, isAttackMove), getMoveType);
			});
			card.addEventListener('keydown', (event) => {
				if (event.key !== 'Enter' && event.key !== ' ') return;
				event.preventDefault();
				openMovePopover(card, target, pickOpponentAttackMoves(target.moves, isAttackMove), getMoveType);
			});
			cardElements.push(card);
			listElement.appendChild(card);
		}
	}

	/**
	 * この値未満の相手は「苦手ではない」として色を付けない。しきい値以上のぶんだけ
	 * 0〜100%へ写し直し、苦手な相手だけがハイライトされるようにする。
	 */
	const MATCHUP_HIGHLIGHT_THRESHOLD = 0.7;
	const MATCHUP_HIGHLIGHT_MAX_MIX = 60;

	function applyMatchupCardResult(targetIndex: number, opacity: number | null): void {
		const card = cardElements[targetIndex];
		if (!card) return;
		const mix =
			opacity !== null && opacity >= MATCHUP_HIGHLIGHT_THRESHOLD
				? ((opacity - MATCHUP_HIGHLIGHT_THRESHOLD) / (1 - MATCHUP_HIGHLIGHT_THRESHOLD)) * MATCHUP_HIGHLIGHT_MAX_MIX
				: 0;
		card.style.setProperty('--matchup-mix', `${mix}%`);
		if (opacity === null) {
			card.dataset.state = 'unknown';
		} else {
			delete card.dataset.state;
		}
	}

	/** 攻撃・防御のうち悪いほう(値が大きいほう)を、そのポケモンのスコアとして採用する。 */
	function worseScore(attack: number | null, defense: number | null): number | null {
		if (attack === null && defense === null) return null;
		return Math.max(attack ?? -Infinity, defense ?? -Infinity);
	}

	function renderMatchupList(
		targets: MatchupTarget[],
		scores: MatchupScoreCacheEntry | null,
		typesMap: Map<string, string[]>,
		isAttackMove: (moveName: string) => boolean,
		getMoveType: (moveName: string) => string | null,
	): void {
		createMatchupCards(targets, typesMap, isAttackMove, getMoveType);
		if (!scores) return;
		const scored = scoreToOpacities(
			targets.map((target, i) => ({ item: target, score: worseScore(scores.attack[i] ?? null, scores.defense[i] ?? null) })),
			'attack',
		);
		for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
			applyMatchupCardResult(targetIndex, scored[targetIndex]?.opacity ?? null);
		}
	}

	document.addEventListener('click', closeMovePopover);
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') closeMovePopover();
	});

	async function run(): Promise<void> {
		const currentRequestId = (requestId += 1);
		// 対象カードを先に描画し、Pyodide の準備・計算結果は後追いで反映する。
		// 進捗文が出入りすると一覧の開始位置が動くため、通常の処理中は表示しない。
		setStatus(null);
		let targets: MatchupTarget[];
		try {
			targets = await loadMatchupTargets();
		} catch (err) {
			console.error(err);
			if (currentRequestId !== requestId) return;
			clearLists();
			setStatus('上位ポケモンの一覧を読み込めませんでした。');
			return;
		}
		if (currentRequestId !== requestId) return;
		if (targets.length === 0) {
			clearLists();
			setStatus('集計データがまだありません。');
			return;
		}
		const [typesMap, moveDetails] = await Promise.all([loadTypesMap(), loadMoveDetailMap()]);
		if (currentRequestId !== requestId) return;
		const isAttackMove = (moveName: string): boolean => {
			const detail = moveDetails.get(moveName);
			return !!detail && detail.category !== 'status';
		};
		const getMoveType = (moveName: string): string | null => moveDetails.get(moveName)?.type ?? null;
		const members = getMembers().filter((member) => member.species_name?.trim() !== '');
		if (members.length === 0) {
			renderMatchupList(targets, null, typesMap, isAttackMove, getMoveType);
			setStatus(options.emptyMembersMessage ?? 'チームにポケモンを入れると相性を計算します。');
			return;
		}
		const cacheKey = members.map((member) => member.id).sort().join(',');
		const cached = scoreCache.get(cacheKey);
		if (cached) {
			renderMatchupList(targets, cached, typesMap, isAttackMove, getMoveType);
			setStatus(null);
			return;
		}
		renderMatchupList(targets, null, typesMap, isAttackMove, getMoveType);
		registerOfflineCache();
		try {
			await initEngine();
		} catch (err) {
			console.error(err);
			if (currentRequestId !== requestId) return;
			setStatus('相性を計算できませんでした。再度お試しください。');
			return;
		}
		if (currentRequestId !== requestId) return;
		const multiHitMoves = await loadMultiHitMoveMap();
		if (currentRequestId !== requestId) return;
		const moveHitCounts: Record<string, number> = {};
		for (const [moveName, hits] of multiHitMoves) moveHitCounts[moveName] = hits[1];
		const teamAttackSpecs = members.map((member) =>
			matchupTeamSpec(member, pickTeamAttackMoves(member.move_names ?? [], isAttackMove)),
		);
		const teamDefenseSpecs = members.map((member) => matchupTeamSpec(member, []));
		const scores: MatchupScoreCacheEntry = {
			attack: new Array(targets.length).fill(null),
			defense: new Array(targets.length).fill(null),
		};
		let engineRestarted = false;
		for (let i = 0; i < targets.length; i += 1) {
			await new Promise((resolve) => window.setTimeout(resolve, 0));
			if (currentRequestId !== requestId) return;
			try {
				const calculateDirection = async (direction: MatchupDirection): Promise<Awaited<ReturnType<typeof computeMatchupScore>>> => {
					try {
						return await computeMatchupScore(
							targets[i], direction, teamAttackSpecs, teamDefenseSpecs, isAttackMove, moveHitCounts,
						);
					} catch (err) {
						console.error(err);
						if (isEngineFatal()) throw err;
						return null;
					}
				};
				const attackResult = await calculateDirection('attack');
				scores.attack[i] = attackResult?.score ?? null;
				const defenseResult = await calculateDirection('defense');
				scores.defense[i] = defenseResult?.score ?? null;
			} catch (err) {
				console.error(err);
				if (currentRequestId !== requestId) return;
				if (isEngineFatal() && !engineRestarted) {
					engineRestarted = true;
					try {
						await resetEngine();
						if (currentRequestId !== requestId) return;
						i -= 1;
						continue;
					} catch (resetErr) {
						console.error(resetErr);
						setStatus('相性を計算できませんでした。ページを再読み込みしてください。');
						return;
					}
				}
				scores.attack[i] = null;
				scores.defense[i] = null;
			}
			if (currentRequestId !== requestId) return;
			const scoredSoFar = scoreToOpacities(
				targets.slice(0, i + 1).map((target, targetIndex) => ({
					item: target,
					score: worseScore(scores.attack[targetIndex] ?? null, scores.defense[targetIndex] ?? null),
				})),
				'attack',
			);
			for (let targetIndex = 0; targetIndex <= i; targetIndex += 1) {
				applyMatchupCardResult(targetIndex, scoredSoFar[targetIndex]?.opacity ?? null);
			}
		}
		if (currentRequestId !== requestId) return;
		scoreCache.set(cacheKey, scores);
		const unknownCount = targets.filter((_, i) => scores.attack[i] === null && scores.defense[i] === null).length;
		setStatus(unknownCount > 0 ? `${unknownCount}体は採用技のデータが無いため計算していません(破線の枠)。` : null);
	}

	return {
		run,
		schedule(delay = 700) {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => void run(), delay);
		},
	};
}
