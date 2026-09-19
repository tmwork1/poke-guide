import {
	championSpriteMediumUrl,
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
	MATCHUP_TARGET_LIMIT,
	OPPONENT_EVS,
	OPPONENT_NATURE,
	averageRatio,
	damageRatio,
	extendMatchupScores,
	matchupDisadvantageScore,
	pickOpponentAttackMoves,
	pickTeamAttackMoves,
	scoreToOpacities,
	type MatchupDirection,
	type MatchupTargetForm,
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
	moves: PopularMoveOption[];
	/** API がメガストーン所持率に応じて展開した、表示・計算対象のフォーム。 */
	forms?: MatchupTargetForm[];
}

interface MatchupScoreCacheEntry {
	attack?: (number | null | undefined)[];
	defense?: (number | null | undefined)[];
	memberRatios?: Partial<Record<MatchupDirection, (number[] | null | undefined)[]>>;
}

let matchupTargetsPromise: Promise<MatchupTarget[]> | null = null;
let imageIdMapPromise: Promise<Map<string, number>> | null = null;

/** ベース種族の採用技を引き継ぎ、フォーム単位のカード・計算対象へ平坦化する。 */
function expandMatchupTargets(targets: readonly MatchupTarget[]): MatchupTarget[] {
	return targets.flatMap((target) => {
		const forms = target.forms ?? [{ speciesName: target.speciesName, dexNo: target.dexNo }];
		return forms.map((form) => ({ ...target, speciesName: form.speciesName, dexNo: form.dexNo }));
	});
}

/** 使用率上位の相手一覧をページ内で一度だけ読み込み、失敗時は次回に再試行する。 */
export async function loadMatchupTargets(): Promise<MatchupTarget[]> {
	if (!matchupTargetsPromise) {
		matchupTargetsPromise = fetch(`/api/matchup-targets?limit=${MATCHUP_TARGET_LIMIT}`, { credentials: 'same-origin' })
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
	// 72px表示なので192pxのWebPで足りる。取得できなければ320px PNGへ退避する。
	imgEl.src = championSpriteMediumUrl(imageId);
}

export interface MatchupPanelOptions {
	attackListElement: HTMLElement;
	defenseListElement: HTMLElement;
	statusElement: HTMLElement;
	moreButtonElement?: HTMLButtonElement;
	getMembers: () => MatchupPanelMember[];
	emptyMembersMessage?: string;
	/** カード選択時に、不利を取っているメンバーの id を通知する。選択解除時は null。 */
	onDisadvantagedMembersChange?: (
		selection: { direction: MatchupDirection; memberIds: string[] } | null,
	) => void;
}

export interface MatchupPanel {
	run(): Promise<void>;
	schedule(delay?: number): void;
}

/** 相性結果の取得、計算、進捗表示、カード描画をまとめたクライアント用パネル。 */
export function createMatchupPanel(options: MatchupPanelOptions): MatchupPanel {
	const {
		attackListElement,
		defenseListElement,
		statusElement,
		moreButtonElement,
		getMembers,
		onDisadvantagedMembersChange,
	} = options;
	const listElements: Record<MatchupDirection, HTMLElement> = {
		attack: attackListElement,
		defense: defenseListElement,
	};
	let requestId = 0;
	let timer: number | undefined;
	let visibleTargetCount = MATCHUP_TOP_N;
	let loadedTargetCount = 0;
	const scoreCache = new Map<string, MatchupScoreCacheEntry>();
	const cardElements: Record<MatchupDirection, HTMLLIElement[]> = { attack: [], defense: [] };
	let activeSelection: { direction: MatchupDirection; targetIndex: number } | null = null;
	let currentCacheKey = '';
	let currentMembers: MatchupPanelMember[] = [];

	// 攻・守のカードグリッドに「計算中…」を重ねる。1匹目の
	// 相性結果が実際に描画されるまでの間だけ表示し、以後はDOMから外して再利用する。
	const calculatingOverlayContainer = attackListElement.parentElement ?? attackListElement;
	calculatingOverlayContainer.classList.add('team-matchup-list-container');
	let calculatingOverlayEl: HTMLDivElement | null = null;

	function showCalculatingOverlay(): void {
		if (!calculatingOverlayEl) {
			calculatingOverlayEl = document.createElement('div');
			calculatingOverlayEl.className = 'team-matchup-calculating';
			calculatingOverlayEl.textContent = '計算中…';
		}
		if (!calculatingOverlayEl.isConnected) calculatingOverlayContainer.appendChild(calculatingOverlayEl);
	}

	function hideCalculatingOverlay(): void {
		calculatingOverlayEl?.remove();
	}

	function clearSelection(): void {
		if (!activeSelection) return;
		cardElements[activeSelection.direction][activeSelection.targetIndex]?.removeAttribute('data-selected');
		activeSelection = null;
		onDisadvantagedMembersChange?.(null);
	}

	function selectCard(direction: MatchupDirection, targetIndex: number): void {
		if (!onDisadvantagedMembersChange) return;
		if (activeSelection?.direction === direction && activeSelection.targetIndex === targetIndex) {
			clearSelection();
			return;
		}
		clearSelection();
		// 未計算・計算不可の相手は比べる材料が無いので、タップしても何も起きない。
		const ratios = scoreCache.get(currentCacheKey)?.memberRatios?.[direction]?.[targetIndex];
		const average = ratios ? averageRatio(ratios) : null;
		if (average === null) return;
		// しきい値はチーム内相対(平均より悪い側)。攻は与ダメ割合が低いほど、
		// 守は被ダメ割合が高いほど不利なので、比較の向きだけを入れ替える。
		const memberIds = currentMembers.flatMap((member, index) =>
			(direction === 'attack' ? ratios[index] < average : ratios[index] > average) ? [member.id] : []);
		const card = cardElements[direction][targetIndex];
		if (!card) return;
		activeSelection = { direction, targetIndex };
		card.dataset.selected = 'true';
		onDisadvantagedMembersChange({ direction, memberIds });
	}

	function setStatus(message: string | null): void {
		if (message === null) {
			statusElement.hidden = true;
			statusElement.textContent = '';
		} else {
			// メッセージ表示時に「計算中…」を重ねない。
			hideCalculatingOverlay();
			statusElement.textContent = message;
			statusElement.hidden = false;
		}
	}

	function clearLists(): void {
		clearSelection();
		for (const direction of ['attack', 'defense'] as const) {
			listElements[direction].innerHTML = '';
			listElements[direction].removeAttribute('aria-busy');
			cardElements[direction] = [];
		}
	}

	function updateMoreButton(totalTargetCount: number, isCalculating: boolean): void {
		if (!moreButtonElement) return;
		moreButtonElement.hidden = visibleTargetCount >= totalTargetCount;
		moreButtonElement.disabled = isCalculating;
	}

	function appendMatchupCards(
		direction: MatchupDirection,
		targets: MatchupTarget[],
		typesMap: Map<string, string[]>,
	): void {
		for (const target of targets) {
			const card = document.createElement('li');
			const cardIndex = cardElements[direction].length;
			card.className = 'team-matchup-card';
			card.dataset.state = 'pending';
			if (onDisadvantagedMembersChange) {
				card.tabIndex = 0;
				card.setAttribute('role', 'button');
				card.setAttribute('aria-label', `${target.speciesName}に不利なメンバーを表示`);
			}
			const img = document.createElement('img');
			img.className = 'team-matchup-sprite-img';
			img.alt = '';
			const fallback = document.createElement('span');
			fallback.className = 'team-matchup-sprite-fallback';
			card.append(img, fallback);
			void applySprite(img, fallback, target.speciesName);
			const typeNames = (typesMap.get(target.speciesName) ?? []).join('/');
			card.title = typeNames ? `${target.speciesName}\n${typeNames}` : target.speciesName;
			if (onDisadvantagedMembersChange) {
				card.addEventListener('click', (event) => {
					event.stopPropagation();
					selectCard(direction, cardIndex);
				});
				card.addEventListener('keydown', (event) => {
					if (event.key !== 'Enter' && event.key !== ' ') return;
					event.preventDefault();
					selectCard(direction, cardIndex);
				});
			}
			cardElements[direction].push(card);
			listElements[direction].appendChild(card);
		}
	}

	/**
	 * この値未満の相手は「苦手ではない」として色を付けない。しきい値以上のぶんだけ
	 * 0〜100%へ写し直し、苦手な相手だけがハイライトされるようにする。
	 */
	const MATCHUP_HIGHLIGHT_THRESHOLD = 0.7;
	const MATCHUP_HIGHLIGHT_MAX_MIX = 60;

	function applyMatchupCardResult(direction: MatchupDirection, targetIndex: number, opacity: number | null): void {
		const card = cardElements[direction][targetIndex];
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

	/** 各方向の結果を独立してカードへ描画し、攻・守の計算結果を混ぜない。 */
	function applyMatchupCardResults(
		direction: MatchupDirection,
		targets: MatchupTarget[],
		scores: (number | null | undefined)[],
	): void {
		const scored = scoreToOpacities(
			targets.map((target, i) => ({ item: target, score: scores[i] ?? null })),
			direction,
		);
		for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
			if (scores[targetIndex] === undefined) continue;
			applyMatchupCardResult(direction, targetIndex, scored[targetIndex]?.opacity ?? null);
		}
	}

	function renderMatchupLists(
		targets: MatchupTarget[],
		attackScores: (number | null | undefined)[] | null,
		defenseScores: (number | null | undefined)[] | null,
		typesMap: Map<string, string[]>,
	): void {
		clearLists();
		appendMatchupCards('attack', targets, typesMap);
		appendMatchupCards('defense', targets, typesMap);
		if (attackScores) applyMatchupCardResults('attack', targets, attackScores);
		if (defenseScores) applyMatchupCardResults('defense', targets, defenseScores);
	}

	if (onDisadvantagedMembersChange) {
		document.addEventListener('click', clearSelection);
		document.addEventListener('keydown', (event) => {
			if (event.key === 'Escape') clearSelection();
		});
	}

	// 強調色(攻=赤系 / 守=主要色)は、各見出しとカード一覧の
	// data-matchup-active-direction を静的に使い分ける。
	async function run(appendFrom?: number): Promise<void> {
		const currentRequestId = (requestId += 1);
		// 「さらに表示」による追加読み込みは既存カードが見えているので対象外。
		// 新規/再計算のときだけ、1匹目の結果が出るまで「計算中…」を重ねる。
		if (appendFrom === undefined) showCalculatingOverlay();
		updateMoreButton(loadedTargetCount, true);
		clearSelection();
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
			updateMoreButton(0, false);
			setStatus('上位ポケモンの一覧を読み込めませんでした。');
			return;
		}
		if (currentRequestId !== requestId) return;
		if (targets.length === 0) {
			clearLists();
			updateMoreButton(0, false);
			setStatus('集計データがまだありません。');
			return;
		}
		loadedTargetCount = targets.length;
		visibleTargetCount = Math.min(visibleTargetCount, targets.length);
		// 続きがあることは相手一覧が取れた時点で分かる。計算が終わるまで隠しておくと
		// 数十秒ボタンが現れないので、ここで出して計算中はdisabledにとどめる。
		updateMoreButton(loadedTargetCount, true);
		const [typesMap, moveDetails] = await Promise.all([loadTypesMap(), loadMoveDetailMap()]);
		if (currentRequestId !== requestId) return;
		const isAttackMove = (moveName: string): boolean => {
			const detail = moveDetails.get(moveName);
			return !!detail && detail.category !== 'status';
		};
		const visibleTargets = targets.slice(0, visibleTargetCount);
		const visibleFormTargets = expandMatchupTargets(visibleTargets);
		const appendedFormTargets = appendFrom === undefined
			? []
			: expandMatchupTargets(targets.slice(appendFrom, visibleTargetCount));
		const members = getMembers().filter((member) => member.species_name?.trim() !== '');
		if (members.length === 0) {
			if (appendFrom !== undefined && cardElements.attack.length > 0 && cardElements.defense.length > 0) {
				appendMatchupCards('attack', appendedFormTargets, typesMap);
				appendMatchupCards('defense', appendedFormTargets, typesMap);
			} else {
				renderMatchupLists(visibleFormTargets, null, null, typesMap);
			}
			setStatus(options.emptyMembersMessage ?? 'チームにポケモンを入れると相性を計算します。');
			updateMoreButton(targets.length, false);
			return;
		}
		// memberRatios は getMembers() の並び順の添字なので、並びが違えばキャッシュも別物。
		// スコア自体は平均なので順不同でよかったが、ここでソートすると並べ替え後に
		// 別メンバーのダメージ割合をハイライトしてしまう。
		const cacheKey = members.map((member) => member.id).join(',');
		currentCacheKey = cacheKey;
		currentMembers = members;
		const cached = scoreCache.get(cacheKey);
		const scores = cached ?? {};
		const attackDirectionScores = extendMatchupScores(scores.attack, visibleFormTargets.length);
		const defenseDirectionScores = extendMatchupScores(scores.defense, visibleFormTargets.length);
		scores.attack = attackDirectionScores;
		scores.defense = defenseDirectionScores;
		const memberRatios = (scores.memberRatios ??= {});
		const attackMemberRatios = (memberRatios.attack = extendMatchupScores(memberRatios.attack, visibleFormTargets.length));
		const defenseMemberRatios = (memberRatios.defense = extendMatchupScores(memberRatios.defense, visibleFormTargets.length));
		scoreCache.set(cacheKey, scores);
		if (appendFrom !== undefined && cardElements.attack.length > 0 && cardElements.defense.length > 0) {
			appendMatchupCards('attack', appendedFormTargets, typesMap);
			appendMatchupCards('defense', appendedFormTargets, typesMap);
			applyMatchupCardResults('attack', visibleFormTargets, attackDirectionScores);
			applyMatchupCardResults('defense', visibleFormTargets, defenseDirectionScores);
		} else {
			renderMatchupLists(visibleFormTargets, attackDirectionScores, defenseDirectionScores, typesMap);
		}
		if (attackDirectionScores.every((score) => score !== undefined) && defenseDirectionScores.every((score) => score !== undefined)) {
			// 全対象がキャッシュ済み。上のrenderMatchupLists/appendMatchupCardsで
			// 既に実際の結果を描画し終えているので、ここで確実に隠す。
			hideCalculatingOverlay();
			updateMoreButton(targets.length, false);
			return;
		}
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
		let engineRestarted = false;
		for (let i = 0; i < visibleFormTargets.length; i += 1) {
			if (attackDirectionScores[i] !== undefined && defenseDirectionScores[i] !== undefined) continue;
			await new Promise((resolve) => window.setTimeout(resolve, 0));
			if (currentRequestId !== requestId) return;
			try {
				const calculateDirection = async (direction: MatchupDirection): Promise<Awaited<ReturnType<typeof computeMatchupScore>>> => {
					try {
						return await computeMatchupScore(
						visibleFormTargets[i], direction, teamAttackSpecs, teamDefenseSpecs, isAttackMove, moveHitCounts,
						);
					} catch (err) {
						console.error(err);
						if (isEngineFatal()) throw err;
						return null;
					}
				};
				// 1体ごとに攻・守をそろえてから次へ進め、左右の進捗行を一致させる。
				if (attackDirectionScores[i] === undefined) {
					const attackResult = await calculateDirection('attack');
					attackDirectionScores[i] = attackResult?.score ?? null;
					attackMemberRatios[i] = attackResult?.memberRatios ?? null;
				}
				if (defenseDirectionScores[i] === undefined) {
					const defenseResult = await calculateDirection('defense');
					defenseDirectionScores[i] = defenseResult?.score ?? null;
					defenseMemberRatios[i] = defenseResult?.memberRatios ?? null;
				}
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
				attackDirectionScores[i] = null;
				defenseDirectionScores[i] = null;
				attackMemberRatios[i] = null;
				defenseMemberRatios[i] = null;
			}
			if (currentRequestId !== requestId) return;
			// 未計算(undefined)の枠は applyMatchupCardResults が飛ばす。nullを渡すと
			// 「計算できなかった」表示になり、計算待ちと区別がつかなくなるため。
			applyMatchupCardResults('attack', visibleFormTargets, attackDirectionScores);
			applyMatchupCardResults('defense', visibleFormTargets, defenseDirectionScores);
			// このループの最初の1周で1匹目の実際の結果が描画されている
			// (以降は既に隠れているため呼んでも何もしない)。
			hideCalculatingOverlay();
		}
		if (currentRequestId !== requestId) return;
		scores.attack = attackDirectionScores;
		scores.defense = defenseDirectionScores;
		scoreCache.set(cacheKey, scores);
		updateMoreButton(targets.length, false);
	}

	moreButtonElement?.addEventListener('click', () => {
		if (moreButtonElement.disabled || visibleTargetCount >= loadedTargetCount) return;
		const appendFrom = visibleTargetCount;
		visibleTargetCount = Math.min(visibleTargetCount + MATCHUP_TOP_N, loadedTargetCount);
		void run(appendFrom);
	});

	return {
		run,
		schedule(delay = 700) {
			window.clearTimeout(timer);
			requestId += 1;
			scoreCache.clear();
			clearSelection();
			updateMoreButton(loadedTargetCount, true);
			timer = window.setTimeout(() => void run(), delay);
		},
	};
}
