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

interface MatchupMemberRatioCacheEntry {
	memberIds: string[];
	ratios: (number[] | null)[];
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
	direction?: MatchupDirection;
	emptyMembersMessage?: string;
	/**
	 * カード選択時に不利なメンバーIDを通知する。null は選択解除を表す。
	 * チーム編集ページは枠のハイライトに使い、個体ページは渡さない。
	 */
	onMemberHighlight?: (memberIds: readonly string[] | null) => void;
}

export interface MatchupPanel {
	run(): Promise<void>;
	schedule(delay?: number): void;
	setDirection(direction: MatchupDirection): void;
	getDirection(): MatchupDirection;
}

/** 相性結果の取得、計算、進捗表示、カード描画をまとめたクライアント用パネル。 */
export function createMatchupPanel(options: MatchupPanelOptions): MatchupPanel {
	const { listElement, statusElement, getMembers, onMemberHighlight } = options;
	let direction = options.direction ?? 'attack';
	let requestId = 0;
	let timer: number | undefined;
	const scoreCache = new Map<string, (number | null)[]>();
	const memberRatioCache = new Map<string, MatchupMemberRatioCacheEntry>();
	let cardElements: HTMLLIElement[] = [];
	const clickableCards = new WeakSet<HTMLLIElement>();
	let selectedTargetIndex: number | null = null;

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
		listElement.innerHTML = '';
		cardElements = [];
	}

	function clearMemberHighlights(): void {
		selectedTargetIndex = null;
		for (const card of listElement.querySelectorAll('.team-matchup-card')) card.classList.remove('is-selected');
		onMemberHighlight?.(null);
	}

	function createMatchupCards(targets: MatchupTarget[], typesMap: Map<string, string[]>): void {
		clearLists();
		clearMemberHighlights();
		for (const target of targets) {
			const card = document.createElement('li');
			card.className = 'team-matchup-card';
			card.dataset.state = 'pending';
			const img = document.createElement('img');
			img.className = 'team-matchup-sprite-img';
			img.alt = '';
			const fallback = document.createElement('span');
			fallback.className = 'team-matchup-sprite-fallback';
			card.append(img, fallback);
			void applySprite(img, fallback, target.speciesName);
			const typeNames = (typesMap.get(target.speciesName) ?? []).join('/');
			card.title = typeNames ? `${target.speciesName}\n${typeNames}` : target.speciesName;
			cardElements.push(card);
			listElement.appendChild(card);
		}
	}

	function applyMatchupCardResult(
		targetIndex: number,
		score: number | null,
		opacity: number | null,
		memberRatios: MatchupMemberRatioCacheEntry,
	): void {
		const card = cardElements[targetIndex];
		if (!card) return;
		card.classList.remove('is-disadvantageous');
		card.style.removeProperty('--matchup-mix');
		if (score === null || opacity === null) {
			card.dataset.state = 'unknown';
			card.querySelector('.team-matchup-score')?.remove();
			return;
		}
		delete card.dataset.state;
		if (opacity >= 0.5) {
			card.classList.add('is-disadvantageous');
			const mix = 28 + (opacity - 0.5) * 84;
			card.style.setProperty('--matchup-mix', `${mix}%`);
		}
		let scoreElement = card.querySelector<HTMLSpanElement>('.team-matchup-score');
		if (!scoreElement) {
			scoreElement = document.createElement('span');
			scoreElement.className = 'team-matchup-score';
			card.appendChild(scoreElement);
		}
		scoreElement.textContent = score.toFixed(2);
		if (clickableCards.has(card)) return;
		clickableCards.add(card);
		card.addEventListener('click', () => {
			const ratios = memberRatios.ratios[targetIndex];
			if (!ratios) return;
			if (selectedTargetIndex === targetIndex) {
				clearMemberHighlights();
				return;
			}
			clearMemberHighlights();
			selectedTargetIndex = targetIndex;
			card.classList.add('is-selected');
			const disadvantagedIds = memberRatios.memberIds.filter((_, i) =>
				direction === 'defense' ? ratios[i] >= 0.5 : ratios[i] < 0.5,
			);
			onMemberHighlight?.(disadvantagedIds);
		});
	}

	function renderMatchupList(
		targets: MatchupTarget[],
		scores: (number | null)[] | null,
		memberRatios: MatchupMemberRatioCacheEntry | null,
		typesMap: Map<string, string[]>,
	): void {
		createMatchupCards(targets, typesMap);
		if (!scores || !memberRatios) return;
		const scored = scoreToOpacities(
			targets.map((target, i) => ({ item: target, score: scores[i] ?? null })),
			direction,
		);
		for (let targetIndex = 0; targetIndex < scored.length; targetIndex += 1) {
			applyMatchupCardResult(targetIndex, scored[targetIndex].score, scored[targetIndex].opacity, memberRatios);
		}
	}

	async function run(): Promise<void> {
		const currentRequestId = (requestId += 1);
		clearMemberHighlights();
		setStatus('上位ポケモンを読み込み中…');
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
		const members = getMembers().filter((member) => member.species_name?.trim() !== '');
		if (members.length === 0) {
			renderMatchupList(targets, null, null, typesMap);
			setStatus(options.emptyMembersMessage ?? 'チームにポケモンを入れると相性を計算します。');
			return;
		}
		const cacheKey = `${direction}|${members.map((member) => member.id).sort().join(',')}`;
		const cached = scoreCache.get(cacheKey);
		const cachedMemberRatios = memberRatioCache.get(cacheKey);
		if (cached && cachedMemberRatios) {
			renderMatchupList(targets, cached, cachedMemberRatios, typesMap);
			setStatus(null);
			return;
		}
		renderMatchupList(targets, null, null, typesMap);
		setStatus('相性チェックを準備中…');
		registerOfflineCache();
		try {
			await initEngine((progress) => {
				if (currentRequestId === requestId && progress.status === 'loading') setStatus(progress.message);
			});
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
		const scores: (number | null)[] = new Array(targets.length).fill(null);
		const memberRatios: (number[] | null)[] = new Array(targets.length).fill(null);
		const memberRatioEntry = { memberIds: members.map((member) => member.id), ratios: memberRatios };
		let engineRestarted = false;
		for (let i = 0; i < targets.length; i += 1) {
			setStatus(`相性を計算中… (${i + 1}/${targets.length})`);
			await new Promise((resolve) => window.setTimeout(resolve, 0));
			if (currentRequestId !== requestId) return;
			try {
				const result = await computeMatchupScore(
					targets[i], direction, teamAttackSpecs, teamDefenseSpecs, isAttackMove, moveHitCounts,
				);
				scores[i] = result?.score ?? null;
				memberRatios[i] = result?.memberRatios ?? null;
			} catch (err) {
				console.error(err);
				if (currentRequestId !== requestId) return;
				if (isEngineFatal() && !engineRestarted) {
					engineRestarted = true;
					setStatus('計算を再試行中…');
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
				scores[i] = null;
			}
			if (currentRequestId !== requestId) return;
			const scoredSoFar = scoreToOpacities(
				targets.slice(0, i + 1).map((target, targetIndex) => ({ item: target, score: scores[targetIndex] ?? null })),
				direction,
			);
			for (let targetIndex = 0; targetIndex < scoredSoFar.length; targetIndex += 1) {
				const entry = scoredSoFar[targetIndex];
				applyMatchupCardResult(targetIndex, entry.score, entry.opacity, memberRatioEntry);
			}
		}
		if (currentRequestId !== requestId) return;
		scoreCache.set(cacheKey, scores);
		memberRatioCache.set(cacheKey, memberRatioEntry);
		const unknownCount = scores.filter((score) => score === null).length;
		setStatus(unknownCount > 0 ? `${unknownCount}体は採用技のデータが無いため計算していません(破線の枠)。` : null);
	}

	return {
		run,
		schedule(delay = 700) {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => void run(), delay);
		},
		setDirection(nextDirection) {
			if (direction === nextDirection) return;
			direction = nextDirection;
			void run();
		},
		getDirection: () => direction,
	};
}
