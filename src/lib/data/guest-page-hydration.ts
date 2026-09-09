import type { OwnedPokemonRecord } from '../owned-pokemon';
import { applyPokemonToMobilePreview } from '../box-id/mobile-preview-hydrate';
import { getGuestPokemon } from './guest-store';
import { isGuestMode } from './guest-mode';

/**
 * Hydrate a guest page's SSR placeholder from localStorage.
 *
 * Logged-in pages return null unchanged. For a guest page, a missing record redirects
 * to /box; otherwise the shared mobile preview is updated in the background and the
 * record is returned for the page-specific continuation.
 */
export function hydrateGuestPagePokemon(id: string): OwnedPokemonRecord | null {
  if (!isGuestMode() || !id) return null;

  const pokemon = getGuestPokemon(id);
  if (!pokemon) {
    window.location.replace('/box');
    return null;
  }

  // Keep page-specific work independent from master-data loading, as it was before
  // this common entry point existed.
  void applyPokemonToMobilePreview(pokemon).catch((error) => console.error(error));
  return pokemon;
}
