import { championSpriteUrl, loadPokemonMasterList, officialArtworkUrl, type PokemonMasterEntry } from '../pokemon-master-data';
import { typeIconUrl } from '../sprite-urls';
import { DEFAULT_TYPE_COLOR, TYPE_COLOR_CSS_VARIABLES } from '../type-colors';
import { calcHpStat, calcOtherStat, NATURE_STAT_MODIFIERS, type StatKey } from '../stats';

interface MegaStoneEntry {
  species: string;
  item: string;
}

interface PokemonDetailEntry {
  name: string;
  baseStats: number[];
  abilities: string[];
}

const statKeys: StatKey[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

let pokemonDetailByNamePromise: Promise<Map<string, PokemonDetailEntry>> | undefined;

function loadPokemonDetailByName(): Promise<Map<string, PokemonDetailEntry>> {
  pokemonDetailByNamePromise ??= fetch('/master-data/detail/pokemon.json')
    .then((response) => response.json() as Promise<PokemonDetailEntry[]>)
    .then((details) => new Map(details.map((detail) => [detail.name, detail])));
  return pokemonDetailByNamePromise;
}

function parseStatValues(value: string | undefined, fallback: number[]): number[] {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length === statKeys.length && parsed.every((stat) => typeof stat === 'number')
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
}

function isMegaForm(entry: PokemonMasterEntry): boolean {
  return entry.forme?.includes('Mega') ?? false;
}

/**
 * モバイルのメイン画像タップでメガ前後を切り替える。
 * 編集フォームがあるページでは種族入力を更新して通常の変更処理へ委ね、ないページでは
 * プレビュー表示のみをローカルで更新する。
 */
export function setupMegaPreviewToggle(): void {
  const preview = document.querySelector<HTMLElement>('.pokemon-preview');
  const spriteWrap = preview?.querySelector<HTMLButtonElement>('.pokemon-preview-sprite-wrap');
  const nameEl = document.getElementById('pokemon-preview-species-name');
  const spriteEl = document.getElementById('pokemon-preview-species-sprite') as HTMLImageElement | null;
  const fallbackEl = document.getElementById('pokemon-preview-species-sprite-fallback');
  const typeIconsEl = preview?.querySelector<HTMLElement>('.pokemon-preview-type-icons');
  const abilityEl = document.getElementById('pokemon-preview-ability');
  const sourceSpeciesInput = document.getElementById('species-name') as HTMLInputElement | null;
  const sourceItemInput = document.getElementById('item') as HTMLInputElement | null;
  const previewItemEl = document.getElementById('pokemon-preview-item');
  if (!preview || !spriteWrap || !nameEl || !spriteEl || !fallbackEl) return;

  let sourceSpecies = sourceSpeciesInput?.value.trim() || preview.dataset.speciesName?.trim() || '';
  let sourceItem = sourceItemInput?.value.trim() || preview.dataset.itemName?.trim() || '';

  void Promise.all([
    loadPokemonMasterList(),
    loadPokemonDetailByName(),
    fetch('/master-data/autocomplete/mega-stones.json').then((response) => response.json() as Promise<MegaStoneEntry[]>),
  ]).then(([master, detailByName, megaStones]) => {
    const byName = new Map(master.map((entry) => [entry.name, entry]));
    const renderSpecies = (name: string): void => {
      const entry = byName.get(name);
      if (!entry) return;
      preview.dataset.speciesName = entry.name;
      nameEl.textContent = entry.name;
      spriteEl.src = championSpriteUrl(entry.imageId);
      spriteEl.alt = entry.name;
      spriteEl.style.display = '';
      spriteEl.onerror = () => {
        spriteEl.onerror = null;
        spriteEl.src = officialArtworkUrl(entry.imageId);
      };
      fallbackEl.style.display = 'none';

      const toMixedColor = (typeName: string): string => {
        const color = TYPE_COLOR_CSS_VARIABLES[typeName] ?? DEFAULT_TYPE_COLOR;
        return `color-mix(in srgb, ${color} 26%, var(--color-bg))`;
      };
      preview.style.background = entry.types.length >= 2
        ? `linear-gradient(to right, ${toMixedColor(entry.types[0])}, ${toMixedColor(entry.types[1])})`
        : toMixedColor(entry.types[0] ?? '');
      typeIconsEl?.replaceChildren(...entry.types.map((typeName) => {
        const icon = document.createElement('img');
        icon.src = typeIconUrl(typeName) ?? '';
        icon.alt = typeName;
        icon.title = typeName;
        return icon;
      }));

      const detail = detailByName.get(entry.name);
      if (abilityEl) abilityEl.textContent = detail?.abilities[0] ?? '-';

      const displayedEvs = statKeys.map((key) => {
        const value = preview.querySelector<HTMLElement>(`#pokemon-preview-ev-${key}`)?.textContent?.trim();
        const ev = value && value !== '-' ? Number(value.replace(/^\+/, '')) : Number.NaN;
        return Number.isFinite(ev) ? ev : undefined;
      });
      const fallbackEvs = parseStatValues(preview.dataset.evs, [0, 0, 0, 0, 0, 0]);
      const evs = displayedEvs.map((ev, index) => ev ?? fallbackEvs[index]);
      const ivs = parseStatValues(preview.dataset.ivs, [31, 31, 31, 31, 31, 31]);
      const level = Number(preview.dataset.level) || 50;
      const nature = NATURE_STAT_MODIFIERS[preview.dataset.nature ?? ''] ?? { up: null, down: null };

      statKeys.forEach((key, index) => {
        const statEl = document.getElementById(`pokemon-preview-stat-${key}`);
        if (!statEl) return;
        const baseStat = detail?.baseStats[index];
        statEl.textContent = typeof baseStat !== 'number'
          ? '-'
          : index === 0
            ? String(calcHpStat(level, baseStat, ivs[index], evs[index]))
            : String(calcOtherStat(level, baseStat, ivs[index], evs[index], nature.up === key ? 1.1 : nature.down === key ? 0.9 : 1));
      });
    };

    const baseForMega = (mega: PokemonMasterEntry): PokemonMasterEntry | undefined => {
      // 性別フォルムは名前の「メガ」だけを外すと一意に戻せる。
      const nameMatchedBase = byName.get(mega.name.replace(/^メガ/, ''));
      return nameMatchedBase ?? master.find((entry) => entry.dexNo === mega.dexNo && entry.forme === null);
    };

    const targetFor = (speciesName: string, itemName: string): PokemonMasterEntry | undefined => {
      const current = byName.get(speciesName);
      if (!current) return undefined;
      if (isMegaForm(current)) return baseForMega(current);
      return megaStones
        .filter((mega) => mega.item === itemName)
        .map((mega) => byName.get(mega.species))
        .find((mega): mega is PokemonMasterEntry => !!mega && mega.dexNo === current.dexNo);
    };

    const renderToggle = (target: PokemonMasterEntry | undefined): void => {
      if (!target) {
        spriteWrap.disabled = true;
        spriteWrap.removeAttribute('title');
        spriteWrap.setAttribute('aria-label', 'ポケモンプレビュー');
        return;
      }
      spriteWrap.disabled = false;
      spriteWrap.setAttribute('aria-label', `${target.name}のプレビューへ切り替え`);
      spriteWrap.title = `${target.name}のプレビューへ切り替え`;
    };

    const sync = (): void => {
      sourceSpecies = sourceSpeciesInput?.value.trim() || preview.dataset.speciesName?.trim() || sourceSpecies;
      sourceItem = sourceItemInput?.value.trim() || preview.dataset.itemName?.trim() || '';
      renderSpecies(sourceSpecies);
      renderToggle(targetFor(sourceSpecies, sourceItem));
    };

    const toggleSpecies = (): void => {
      const target = targetFor(sourceSpecies, sourceItem);
      if (!target) return;
      if (sourceSpeciesInput) {
        if (sourceSpeciesInput.value === target.name) return;
        // 種族選択ダイアログと同じinput/changeイベントを発火することで、種族値・特性候補・
        // メガストーン自動設定・実数値計算・自動保存を既存の通常の種族変更経路で更新する。
        sourceSpeciesInput.value = target.name;
        sourceSpeciesInput.dispatchEvent(new Event('input', { bubbles: true }));
        sourceSpeciesInput.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      sourceSpecies = target.name;
      renderSpecies(sourceSpecies);
      renderToggle(targetFor(sourceSpecies, sourceItem));
    };
    // モバイルではclickを待たず、最初に届くpointerdownで切り替える。
    // clickはキーボード操作のフォールバックとして残す。
    let handledByPointer = false;
    spriteWrap.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      handledByPointer = true;
      toggleSpecies();
    });
    spriteWrap.addEventListener('click', () => {
      if (handledByPointer) {
        handledByPointer = false;
        return;
      }
      toggleSpecies();
    });

    sourceSpeciesInput?.addEventListener('input', sync);
    sourceSpeciesInput?.addEventListener('change', sync);
    sourceItemInput?.addEventListener('input', sync);
    sourceItemInput?.addEventListener('change', sync);
    if (previewItemEl) new MutationObserver(sync).observe(previewItemEl, { childList: true, characterData: true, subtree: true });
    sync();
  }).catch((error) => console.warn('メガシンカプレビューの準備に失敗しました', error));
}
