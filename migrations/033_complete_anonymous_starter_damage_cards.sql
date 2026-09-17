-- Some anonymous starter accounts were created while the original sequential
-- seeding request ended early. Complete only those exact nine-Pokémon starter
-- rosters, preserving every card that has already been created.
WITH starter_cards (species_name, opponent_build, attack_move, defense_moves) AS (
  VALUES
    ('フシギバナ', jsonb_build_object('name', 'ガブリアス', 'level', 50, 'nature', 'いじっぱり', 'abilityName', 'さめはだ', 'itemName', 'オボンのみ', 'moveNames', jsonb_build_array('ドラゴンテール', 'じしん', 'ステルスロック', 'まもる'), 'evs', jsonb_build_array(32, 0, 32, 0, 0, 2)), 'ヘドロばくだん', ARRAY['じしん', 'ドラゴンテール']),
    ('リザードン', jsonb_build_object('name', 'サーフゴー', 'level', 50, 'abilityName', 'おうごんのからだ', 'itemName', 'こだわりスカーフ', 'moveNames', jsonb_build_array('ゴールドラッシュ', 'シャドーボール', '10まんボルト', 'トリック'), 'evs', jsonb_build_array(1, 0, 0, 32, 1, 32)), 'かえんほうしゃ', ARRAY['10まんボルト', 'シャドーボール']),
    ('カメックス', jsonb_build_object('name', 'ガオガエン', 'level', 50, 'abilityName', 'いかく', 'itemName', 'オボンのみ', 'moveNames', jsonb_build_array('つるぎのまい', 'ドレインパンチ')), 'ハイドロポンプ', ARRAY['ねこだまし', 'ドレインパンチ']),
    ('ジュカイン', jsonb_build_object('name', 'ラグラージ', 'level', 50, 'nature', 'いじっぱり', 'abilityName', 'すいすい', 'itemName', 'ラグラージナイト', 'moveNames', jsonb_build_array('ウェーブタックル', 'じしん', 'れいとうパンチ', 'まもる'), 'evs', jsonb_build_array(16, 23, 0, 0, 0, 27)), 'リーフストーム', ARRAY['れいとうパンチ', 'ウェーブタックル']),
    ('バシャーモ', jsonb_build_object('name', 'アーマーガア', 'level', 50, 'nature', 'しんちょう', 'abilityName', 'プレッシャー', 'itemName', 'たべのこし', 'moveNames', jsonb_build_array('ブレイブバード', 'ビルドアップ', 'はねやすめ', 'ちょうはつ'), 'evs', jsonb_build_array(32, 0, 0, 0, 28, 6)), 'フレアドライブ', ARRAY['ブレイブバード', 'アイアンヘッド']),
    ('ラグラージ', jsonb_build_object('name', 'ガブリアス', 'level', 50, 'nature', 'いじっぱり', 'abilityName', 'さめはだ', 'itemName', 'オボンのみ', 'moveNames', jsonb_build_array('ドラゴンテール', 'じしん', 'ステルスロック', 'まもる'), 'evs', jsonb_build_array(32, 0, 32, 0, 0, 2)), 'じしん', ARRAY['じしん', 'ドラゴンテール']),
    ('メガニウム', jsonb_build_object('name', 'ガブリアス', 'level', 50, 'nature', 'いじっぱり', 'abilityName', 'さめはだ', 'itemName', 'オボンのみ', 'moveNames', jsonb_build_array('ドラゴンテール', 'じしん', 'ステルスロック', 'まもる'), 'evs', jsonb_build_array(32, 0, 32, 0, 0, 2)), 'タネマシンガン', ARRAY['じしん', 'ドラゴンテール']),
    ('バクフーン', jsonb_build_object('name', 'サーフゴー', 'level', 50, 'abilityName', 'おうごんのからだ', 'itemName', 'こだわりスカーフ', 'moveNames', jsonb_build_array('ゴールドラッシュ', 'シャドーボール', '10まんボルト', 'トリック'), 'evs', jsonb_build_array(1, 0, 0, 32, 1, 32)), 'かえんほうしゃ', ARRAY['シャドーボール', 'ゴールドラッシュ']),
    ('オーダイル', jsonb_build_object('name', 'ガオガエン', 'level', 50, 'abilityName', 'いかく', 'itemName', 'オボンのみ', 'moveNames', jsonb_build_array('つるぎのまい', 'ドレインパンチ')), 'たきのぼり', ARRAY['ねこだまし', 'ドレインパンチ'])
),
starter_users AS (
  SELECT pokemon.user_id
  FROM owned_pokemon AS pokemon
  JOIN auth.users AS app_user ON app_user.id = pokemon.user_id
  WHERE app_user.is_anonymous = true
  GROUP BY pokemon.user_id
  HAVING count(*) = 9
     AND count(*) FILTER (WHERE pokemon.species_name IN (SELECT species_name FROM starter_cards)) = 9
),
missing_cards AS (
  SELECT pokemon.id AS owned_pokemon_id, pokemon.user_id, card.opponent_build, 'attack'::text AS direction,
    jsonb_build_array(jsonb_build_object('moveName', card.attack_move)) AS attacks, card.attack_move AS move_name
  FROM starter_users
  JOIN owned_pokemon AS pokemon ON pokemon.user_id = starter_users.user_id
  JOIN starter_cards AS card ON card.species_name = pokemon.species_name
  WHERE NOT EXISTS (
    SELECT 1 FROM opponent_notes AS note
    WHERE note.owned_pokemon_id = pokemon.id AND note.field ->> 'direction' = 'attack'
  )
  UNION ALL
  SELECT pokemon.id, pokemon.user_id, card.opponent_build, 'defense',
    jsonb_build_array(jsonb_build_object('moveName', card.defense_moves[1]), jsonb_build_object('moveName', card.defense_moves[2])), card.defense_moves[1]
  FROM starter_users
  JOIN owned_pokemon AS pokemon ON pokemon.user_id = starter_users.user_id
  JOIN starter_cards AS card ON card.species_name = pokemon.species_name
  WHERE NOT EXISTS (
    SELECT 1 FROM opponent_notes AS note
    WHERE note.owned_pokemon_id = pokemon.id AND note.field ->> 'direction' = 'defense'
  )
)
INSERT INTO opponent_notes (owned_pokemon_id, user_id, opponent_build, field, move_name, client_result, memo)
SELECT owned_pokemon_id, user_id, opponent_build,
  jsonb_build_object('direction', direction, 'attacks', attacks), move_name, NULL, NULL
FROM missing_cards;
