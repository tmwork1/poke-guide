// 育成パネル(pokemon-edit-panel.ts)が編集内容を同一ページの他UIへ知らせるためのDOMイベント。
// 保存(PUT)の完了を待たずに発火するので、受け手は「保存済みの値」ではなく「編集中の値」を
// 受け取る前提で使う。
//
// 定数だけをこの小さなモジュールに置いているのは、受け手(SpeedAdjustDialog.astro)が
// 巨大な pokemon-edit-panel.ts を import せずに済むようにするため。
export const OWNED_EDIT_CHANGED_EVENT = 'owned-pokemon:edit-changed';

/** buildPayload() が返す「編集中のレコード」。OwnedPokemonRecord の一部フィールド。 */
export interface OwnedEditChangedDetail {
	species_name: string;
	level: number | null;
	nature: string | null;
	ability_name: string;
	item_name: string;
	tera_type: string;
	evs: number[];
	ivs: number[];
	move_names: string[];
	memo: string;
	tags: string[];
}
