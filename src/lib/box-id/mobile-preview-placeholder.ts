// SSRではlocalStorageを読めないデータ系ページが、ゲスト個体のプレビュー枠だけ先に描くための値。
import type { OwnedPokemonRecord } from '../owned-pokemon';

export function createMobilePreviewPlaceholder(id: string): OwnedPokemonRecord {
  return {
    id, user_id: '', guest_local_id: null, species_name: '', level: null, nature: null,
    ability_name: null, item_name: null, tera_type: null, evs: [0, 0, 0, 0, 0, 0],
    ivs: [31, 31, 31, 31, 31, 31], move_names: [], memo: null, tags: [], source_build_slug: null,
    share_slug: null, is_public: false, created_at: '', updated_at: '', last_used_at: null,
    collection_opt_out_until: null, archetype_id: null,
  };
}
