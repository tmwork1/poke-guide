// データ系の個体ページではSSRからゲストのlocalStorageを読めないため、
// MobileTrainingBar.astroが出力した空のプレビューをクライアントで実データへ置き換える。
import type { OwnedPokemonRecord } from '../owned-pokemon';
import { getGuestPokemon } from '../data/guest-store';
import { isGuestMode } from '../data/guest-mode';
import { loadBaseStatsMap, loadImageIdMap, loadTypesMap, championSpriteUrl, officialArtworkUrl } from '../pokemon-master-data';
import { itemIconUrl, typeIconUrl } from '../sprite-urls';
import { DEFAULT_TYPE_COLOR, TYPE_COLORS } from '../type-colors';
import { NATURE_STAT_MODIFIERS, STAT_KEYS, calcHpStat, calcOtherStat } from '../stats';
import { applyPreviewMoveTypeBar } from './preview-move-type-bar';

function setText(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = value || '-';
}

/** Apply an owned Pokémon to the read-only mobile preview shared by data pages. */
export async function applyPokemonToMobilePreview(pokemon: OwnedPokemonRecord): Promise<void> {
  const preview = document.querySelector<HTMLElement>('.pokemon-preview');
  if (!preview) return;

  const level = pokemon.level ?? 50;
  const nature = NATURE_STAT_MODIFIERS[pokemon.nature ?? ''] ?? { up: null, down: null };
  preview.dataset.speciesName = pokemon.species_name;
  preview.dataset.itemName = pokemon.item_name?.trim() ?? '';
  preview.dataset.level = String(level);
  preview.dataset.nature = pokemon.nature ?? '';
  preview.dataset.ivs = JSON.stringify(pokemon.ivs);
  preview.dataset.evs = JSON.stringify(pokemon.evs);
  setText('pokemon-preview-species-name', pokemon.species_name);
  setText('pokemon-preview-ability', pokemon.ability_name ?? '');

  for (let slot = 1; slot <= 4; slot++) {
    const moveName = pokemon.move_names[slot - 1] ?? '';
    setText(`pokemon-preview-move-${slot}`, moveName);
    applyPreviewMoveTypeBar(slot, moveName);
  }

  const itemName = pokemon.item_name?.trim() ?? '';
  const item = document.getElementById('pokemon-preview-item');
  if (item) {
    item.textContent = itemName || 'もちものなし';
    item.dataset.empty = String(itemName === '');
  }
  const itemImage = document.getElementById('pokemon-preview-item-image') as HTMLImageElement | null;
  if (itemImage) {
    itemImage.src = itemName ? itemIconUrl(itemName) : '';
    itemImage.classList.toggle('pokemon-preview-item-image-hidden', itemName === '');
  }

  const [baseStatsByName, imageIds, typesByName] = await Promise.all([
    loadBaseStatsMap(),
    loadImageIdMap(),
    loadTypesMap(),
  ]);
  const baseStats = baseStatsByName.get(pokemon.species_name);
  for (let index = 0; index < STAT_KEYS.length; index++) {
    const key = STAT_KEYS[index];
    const stat = document.getElementById(`pokemon-preview-stat-${key}`);
    const statHeader = stat?.previousElementSibling as HTMLElement | null;
    const multiplier = nature.up === key ? 1.1 : nature.down === key ? 0.9 : 1;
    if (stat) {
      stat.textContent = baseStats
        ? String(index === 0
          ? calcHpStat(level, baseStats[index], pokemon.ivs[index] ?? 31, pokemon.evs[index] ?? 0)
          : calcOtherStat(level, baseStats[index], pokemon.ivs[index] ?? 31, pokemon.evs[index] ?? 0, multiplier))
        : '-';
      if (nature.up === key) stat.dataset.mod = 'up';
      else if (nature.down === key) stat.dataset.mod = 'down';
      else delete stat.dataset.mod;
    }
    if (statHeader) {
      if (nature.up === key) statHeader.dataset.mod = 'up';
      else if (nature.down === key) statHeader.dataset.mod = 'down';
      else delete statHeader.dataset.mod;
    }
    setText(`pokemon-preview-ev-${key}`, pokemon.evs[index] ? `+${pokemon.evs[index]}` : '');
  }

  const imageId = imageIds.get(pokemon.species_name);
  const sprite = document.getElementById('pokemon-preview-species-sprite') as HTMLImageElement | null;
  const fallback = document.getElementById('pokemon-preview-species-sprite-fallback') as HTMLElement | null;
  if (sprite && fallback) {
    sprite.alt = pokemon.species_name;
    if (imageId === undefined) {
      sprite.style.display = 'none';
      fallback.style.display = '';
      fallback.textContent = pokemon.species_name.slice(0, 1) || '-';
    } else {
      sprite.src = championSpriteUrl(imageId);
      sprite.onerror = () => { sprite.onerror = null; sprite.src = officialArtworkUrl(imageId); };
      sprite.style.display = '';
      fallback.style.display = 'none';
    }
  }

  const typeIcons = document.getElementById('pokemon-preview-type-icons');
  if (typeIcons) {
    typeIcons.replaceChildren();
    for (const typeName of typesByName.get(pokemon.species_name) ?? []) {
      const icon = document.createElement('img');
      icon.className = 'type-badge-img';
      icon.width = 20;
      icon.height = 20;
      icon.alt = typeName;
      icon.title = typeName;
      const url = typeIconUrl(typeName);
      if (url) {
        icon.src = url;
        icon.onerror = () => {
          icon.replaceWith(Object.assign(document.createElement('span'), {
            className: 'type-badge-fallback', title: typeName,
          }, { style: `background-color: ${TYPE_COLORS[typeName] ?? DEFAULT_TYPE_COLOR}` }));
        };
        typeIcons.appendChild(icon);
      } else {
        const fallbackIcon = document.createElement('span');
        fallbackIcon.className = 'type-badge-fallback';
        fallbackIcon.title = typeName;
        fallbackIcon.style.backgroundColor = TYPE_COLORS[typeName] ?? DEFAULT_TYPE_COLOR;
        typeIcons.appendChild(fallbackIcon);
      }
    }
  }
}

/** Read one guest record and apply it to the mobile preview. Returns null when it no longer exists. */
export async function hydrateGuestMobilePreview(id: string): Promise<OwnedPokemonRecord | null> {
  if (!isGuestMode() || !id) return null;
  const pokemon = getGuestPokemon(id);
  if (pokemon) await applyPokemonToMobilePreview(pokemon);
  return pokemon;
}
