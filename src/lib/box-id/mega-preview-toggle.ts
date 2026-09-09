import { loadPokemonCoreDetailMap, loadPokemonMasterList, type PokemonMasterEntry } from '../pokemon-master-data';
import { applyPokemonPreview } from './preview-apply';
import { buildPokemonPreviewViewModel } from './preview-view-model';

interface MegaStoneEntry {
  species: string;
  item: string;
}

// 種族値と特性しか使わないので、learnsetを含まない軽量マスタ(pokemon-master-data.ts が
// アプリ内で1回だけfetch+parseして共有する)を使う。以前はこのファイルが独自に
// detail/pokemon.json(1.6MB)をfetchしており、同じJSONを二重にparseしていた。
const loadPokemonDetailByName = loadPokemonCoreDetailMap;

function parseStatValues(value: string | undefined, fallback: number[]): number[] {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length === 6 && parsed.every((stat) => typeof stat === 'number')
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
 * モバイルのメイン画面だけでメガ石による姿の切替を行う。
 * 初期HTMLはSSR済みなので、初期化では切替可否だけを更新する。
 */
export function setupMegaPreviewToggle(): void {
  const preview = document.querySelector<HTMLElement>('.pokemon-preview');
  const spriteWrap = preview?.querySelector<HTMLButtonElement>('.pokemon-preview-sprite-wrap');
  const abilitySelectEl = document.getElementById('ability') as HTMLSelectElement | null;
  const sourceSpeciesInput = document.getElementById('species-name') as HTMLInputElement | null;
  const sourceItemInput = document.getElementById('item') as HTMLInputElement | null;
  const previewItemEl = document.getElementById('pokemon-preview-item');
  if (!preview || !spriteWrap) return;

  let sourceSpecies = sourceSpeciesInput?.value.trim() || preview.dataset.speciesName?.trim() || '';
  let sourceItem = sourceItemInput?.value.trim() || preview.dataset.itemName?.trim() || '';

  void Promise.all([
    loadPokemonMasterList(),
    fetch('/master-data/autocomplete/mega-stones.json').then((response) => response.json() as Promise<MegaStoneEntry[]>),
  ]).then(([master, megaStones]) => {
    const byName = new Map(master.map((entry) => [entry.name, entry]));
    const baseForMega = (mega: PokemonMasterEntry): PokemonMasterEntry | undefined => {
      // 性別フォームでは名前の「メガ」を外すと一意に基礎形へ戻せる。
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
    const renderSpecies = async (name: string): Promise<void> => {
      const entry = byName.get(name);
      const details = await loadPokemonDetailByName();
      // 編集フォームの現在値を読み、SSRと同じview model経由で種族差分を適用する。
      const abilityName = abilitySelectEl?.selectedOptions[0]?.textContent?.trim()
        || abilitySelectEl?.value.trim()
        || details.get(name)?.abilities[0]
        || '';
      const displayedEvs = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].map((key) => {
        const value = document.getElementById(`pokemon-preview-ev-${key}`)?.textContent?.trim();
        const ev = value && value !== '-' ? Number(value.replace(/^\+/, '')) : Number.NaN;
        return Number.isFinite(ev) ? ev : undefined;
      });
      const fallbackEvs = parseStatValues(preview.dataset.evs, [0, 0, 0, 0, 0, 0]);
      const evs = displayedEvs.map((ev, index) => ev ?? fallbackEvs[index]);
      applyPokemonPreview(buildPokemonPreviewViewModel({
        species_name: name,
        ability_name: abilityName,
        item_name: sourceItem,
        move_names: [0, 1, 2, 3].map((slot) => document.getElementById(`pokemon-preview-move-${slot + 1}`)?.textContent?.trim() ?? ''),
        level: Number(preview.dataset.level) || 50,
        nature: preview.dataset.nature ?? '',
        ivs: parseStatValues(preview.dataset.ivs, [31, 31, 31, 31, 31, 31]),
        evs,
      }, { species: entry, detail: details.get(name) }));
    };
    const sync = (): void => {
      sourceSpecies = sourceSpeciesInput
        ? sourceSpeciesInput.value.trim()
        : preview.dataset.speciesName?.trim() || sourceSpecies;
      sourceItem = sourceItemInput?.value.trim() || preview.dataset.itemName?.trim() || '';
      void renderSpecies(sourceSpecies);
      renderToggle(targetFor(sourceSpecies, sourceItem));
    };
    const syncToggleOnly = (): void => {
      sourceSpecies = sourceSpeciesInput?.value.trim() || preview.dataset.speciesName?.trim() || sourceSpecies;
      sourceItem = sourceItemInput?.value.trim() || preview.dataset.itemName?.trim() || '';
      renderToggle(targetFor(sourceSpecies, sourceItem));
    };
    const toggleSpecies = (): void => {
      const target = targetFor(sourceSpecies, sourceItem);
      if (!target) return;
      if (sourceSpeciesInput) {
        if (sourceSpeciesInput.value === target.name) return;
        // 入力イベントを経由して編集フォームの選択肢・特性・技を同じ順序で更新する。
        sourceSpeciesInput.value = target.name;
        sourceSpeciesInput.dispatchEvent(new Event('input', { bubbles: true }));
        sourceSpeciesInput.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      sourceSpecies = target.name;
      void renderSpecies(sourceSpecies);
      renderToggle(targetFor(sourceSpecies, sourceItem));
    };
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
    preview.addEventListener('pokemonpreviewchange', syncToggleOnly);
    if (previewItemEl) new MutationObserver(() => {
      // 共通適用が同じ値を書き戻したMutationでは再描画せず、実際の持ち物変更だけを拾う。
      const renderedItem = previewItemEl.textContent?.trim() || '';
      if (renderedItem === (preview.dataset.itemName || 'もちものなし')) return;
      sync();
    }).observe(previewItemEl, { childList: true, characterData: true, subtree: true });
    // SSR済みの表示値には触れず、スプライトがメガ対象かだけを判定する。
    syncToggleOnly();
  }).catch((error) => console.warn('メガシンカプレビューの準備に失敗しました', error));
}
