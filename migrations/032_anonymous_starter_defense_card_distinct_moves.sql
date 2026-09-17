-- The first version of three anonymous starter defense cards repeated the same
-- move twice. Replace only those exact seeded cards with two distinct moves.
WITH replacements (species_name, old_moves, new_moves) AS (
  VALUES
    ('カメックス', ARRAY['ドレインパンチ', 'ドレインパンチ'], ARRAY['ねこだまし', 'ドレインパンチ']),
    ('バシャーモ', ARRAY['ブレイブバード', 'ブレイブバード'], ARRAY['ブレイブバード', 'アイアンヘッド']),
    ('オーダイル', ARRAY['ドレインパンチ', 'ドレインパンチ'], ARRAY['ねこだまし', 'ドレインパンチ'])
)
UPDATE opponent_notes AS note
SET
  field = jsonb_build_object(
    'direction', 'defense',
    'attacks', jsonb_build_array(
      jsonb_build_object('moveName', replacements.new_moves[1]),
      jsonb_build_object('moveName', replacements.new_moves[2])
    )
  ),
  move_name = replacements.new_moves[1]
FROM owned_pokemon AS pokemon
JOIN auth.users AS app_user ON app_user.id = pokemon.user_id
JOIN replacements ON replacements.species_name = pokemon.species_name
WHERE note.owned_pokemon_id = pokemon.id
  AND note.user_id = pokemon.user_id
  AND app_user.is_anonymous = true
  AND note.field ->> 'direction' = 'defense'
  AND jsonb_array_length(note.field -> 'attacks') = 2
  AND ARRAY(
    SELECT attack ->> 'moveName'
    FROM jsonb_array_elements(note.field -> 'attacks') WITH ORDINALITY AS moves(attack, position)
    ORDER BY position
  ) = replacements.old_moves;
