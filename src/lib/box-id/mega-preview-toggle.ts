import { championSpriteUrl, loadPokemonMasterList, officialArtworkUrl, type PokemonMasterEntry } from '../pokemon-master-data';
import { typeIconUrl } from '../sprite-urls';
import { DEFAULT_TYPE_COLOR, TYPE_COLOR_CSS_VARIABLES } from '../type-colors';

interface MegaStoneEntry {
  species: string;
  item: string;
}

function isMegaForm(entry: PokemonMasterEntry): boolean {
  return entry.forme?.includes('Mega') ?? false;
}

/**
 * モバイルのポケモンプレビューだけで、メガ前後の種族表示を切り替える。
 * 編集フォームの種族・持ち物・保存データには一切書き込まない。
 */
export function setupMegaPreviewToggle(): void {
  const preview = document.querySelector<HTMLElement>('.pokemon-preview');
  const previewMain = preview?.querySelector<HTMLElement>('.pokemon-preview-main');
  const spriteWrap = preview?.querySelector<HTMLElement>('.pokemon-preview-sprite-wrap');
  const nameEl = document.getElementById('pokemon-preview-species-name');
  const spriteEl = document.getElementById('pokemon-preview-species-sprite') as HTMLImageElement | null;
  const fallbackEl = document.getElementById('pokemon-preview-species-sprite-fallback');
  const typeIconsEl = preview?.querySelector<HTMLElement>('.pokemon-preview-type-icons');
  const sourceSpeciesInput = document.getElementById('species-name') as HTMLInputElement | null;
  const sourceItemInput = document.getElementById('item') as HTMLInputElement | null;
  const previewItemEl = document.getElementById('pokemon-preview-item');
  if (!preview || !previewMain || !spriteWrap || !nameEl || !spriteEl || !fallbackEl) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pokemon-preview-mega-toggle';
  button.hidden = true;
  spriteWrap.append(button);

  let shownSpecies = '';
  let sourceSpecies = sourceSpeciesInput?.value.trim() || preview.dataset.speciesName?.trim() || '';
  let sourceItem = sourceItemInput?.value.trim() || preview.dataset.itemName?.trim() || '';

  void Promise.all([
    loadPokemonMasterList(),
    fetch('/master-data/autocomplete/mega-stones.json').then((response) => response.json() as Promise<MegaStoneEntry[]>),
  ]).then(([master, megaStones]) => {
    const byName = new Map(master.map((entry) => [entry.name, entry]));
    const renderSpecies = (name: string): void => {
      const entry = byName.get(name);
      if (!entry) return;
      shownSpecies = entry.name;
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
      previewMain.style.background = entry.types.length >= 2
        ? `linear-gradient(to right, ${toMixedColor(entry.types[0])}, ${toMixedColor(entry.types[1])})`
        : toMixedColor(entry.types[0] ?? '');
      typeIconsEl?.replaceChildren(...entry.types.map((typeName) => {
        const icon = document.createElement('img');
        icon.src = typeIconUrl(typeName) ?? '';
        icon.alt = typeName;
        icon.title = typeName;
        return icon;
      }));
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
        button.hidden = true;
        return;
      }
      button.hidden = false;
      button.replaceChildren(document.createTextNode('↔'));
      const icon = document.createElement('img');
      icon.src = championSpriteUrl(target.imageId);
      icon.alt = target.name;
      icon.onerror = () => {
        icon.onerror = null;
        icon.src = officialArtworkUrl(target.imageId);
      };
      button.append(icon);
      button.setAttribute('aria-label', `${target.name}のプレビューへ切り替え`);
      button.title = `${target.name}のプレビューへ切り替え`;
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
      renderSpecies(shownSpecies === sourceSpecies ? target.name : sourceSpecies);
      renderToggle(shownSpecies === sourceSpecies ? target : byName.get(sourceSpecies));
    };
    // モバイルではclickを待たず、最初に届くpointerdownで切り替える。
    // clickはキーボード操作のフォールバックとして残す。
    let handledByPointer = false;
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      handledByPointer = true;
      toggleSpecies();
    });
    button.addEventListener('click', () => {
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
