import { DEFAULT_TYPE_COLOR, TYPE_COLORS } from '../type-colors';
import { applyPreviewMoveTypeBar } from './preview-move-type-bar';
import { STAT_KEYS, type PokemonPreviewViewModel } from './preview-view-model';

function setText(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = value || '-';
}

function applyTypeIcons(container: HTMLElement | null, view: PokemonPreviewViewModel): void {
  if (!container) return;
  container.replaceChildren(...view.typeIcons.map((type) => {
    if (!type.url) {
      const fallback = document.createElement('span');
      fallback.className = 'type-badge-fallback';
      fallback.title = type.name;
      fallback.style.backgroundColor = type.fallbackColor;
      return fallback;
    }
    const icon = document.createElement('img');
    icon.className = 'type-badge-img';
    icon.width = 20;
    icon.height = 20;
    icon.src = type.url;
    icon.alt = type.name;
    icon.title = type.name;
    icon.onerror = () => {
      const fallback = document.createElement('span');
      fallback.className = 'type-badge-fallback';
      fallback.title = type.name;
      fallback.style.backgroundColor = TYPE_COLORS[type.name] ?? DEFAULT_TYPE_COLOR;
      icon.replaceWith(fallback);
    };
    return icon;
  }));
}

function ensureItemImage(item: HTMLElement, itemName: string): HTMLImageElement | null {
  let image = document.getElementById('pokemon-preview-item-image') as HTMLImageElement | null;
  if (!image && itemName) {
    image = document.createElement('img');
    image.id = 'pokemon-preview-item-image';
    image.alt = '';
    image.className = 'pokemon-preview-item-image';
    image.onerror = () => { image?.style.setProperty('display', 'none'); };
    item.parentElement?.insertBefore(image, item);
  }
  return image;
}

/** 共有プレビューDOMへview modelを書き込む。ゲスト復元では実数値だけ後追いできる。 */
export function applyPokemonPreview(
  view: PokemonPreviewViewModel,
  options: { applyStats?: boolean; applyContent?: boolean } = {},
): void {
  const preview = document.querySelector<HTMLElement>('.pokemon-preview');
  if (!preview) return;
  const applyStats = options.applyStats ?? true;
  const applyContent = options.applyContent ?? true;

  if (applyContent) {
    preview.dataset.speciesName = view.speciesName;
    preview.dataset.itemName = view.itemName;
    preview.dataset.level = String(view.level);
    preview.dataset.nature = view.natureName;
    preview.dataset.ivs = JSON.stringify(view.ivs);
    preview.dataset.evs = JSON.stringify(view.evs);
    // 背景の当て方はmobile-pokemon-preview.css側にあり、ここは値だけを渡す。
    if (view.background) preview.style.setProperty('--pokemon-preview-background', view.background);
    else preview.style.removeProperty('--pokemon-preview-background');

    setText('pokemon-preview-species-name', view.speciesName);
    setText('pokemon-preview-ability', view.abilityName);
    view.moves.forEach((moveName, index) => {
      setText(`pokemon-preview-move-${index + 1}`, moveName);
      applyPreviewMoveTypeBar(index + 1, moveName);
    });

    const item = document.getElementById('pokemon-preview-item');
    if (item) {
      item.textContent = view.itemName || 'もちものなし';
      item.dataset.empty = String(view.itemName === '');
      const itemImage = ensureItemImage(item, view.itemName);
      if (itemImage) {
        itemImage.src = view.itemIconUrl ?? '';
        itemImage.classList.toggle('pokemon-preview-item-image-hidden', view.itemName === '');
        itemImage.style.removeProperty('display');
      }
    }

    const sprite = document.getElementById('pokemon-preview-species-sprite') as HTMLImageElement | null;
    const fallback = document.getElementById('pokemon-preview-species-sprite-fallback');
    if (sprite && fallback) {
      sprite.alt = view.speciesName;
      if (!view.championSpriteUrl) {
        sprite.hidden = true;
        fallback.hidden = view.speciesName === '';
        fallback.textContent = view.speciesName.slice(0, 1);
      } else {
        sprite.src = view.championSpriteUrl;
        let triedFull = false;
        sprite.onerror = () => {
          if (!triedFull && view.championSpriteFullUrl) {
            triedFull = true;
            sprite.src = view.championSpriteFullUrl;
            return;
          }
          sprite.onerror = null;
          if (view.officialArtworkUrl) sprite.src = view.officialArtworkUrl;
        };
        sprite.hidden = false;
        fallback.hidden = true;
      }
    }
    applyTypeIcons(document.getElementById('pokemon-preview-type-icons'), view);
  }

  STAT_KEYS.forEach((key, index) => {
    const stat = document.getElementById(`pokemon-preview-stat-${key}`);
    const statHeader = stat?.previousElementSibling as HTMLElement | null;
    const mod = view.nature.up === key ? 'up' : view.nature.down === key ? 'down' : undefined;
    if (applyStats && stat) stat.textContent = view.stats[index] === null ? '-' : String(view.stats[index]);
    if (stat) {
      if (mod) stat.dataset.mod = mod;
      else delete stat.dataset.mod;
    }
    if (statHeader) {
      if (mod) statHeader.dataset.mod = mod;
      else delete statHeader.dataset.mod;
    }
    setText(`pokemon-preview-ev-${key}`, view.evLabels[index] === '-' ? '' : view.evLabels[index]);
  });
  if (applyContent) preview.dispatchEvent(new CustomEvent('pokemonpreviewchange'));
}
