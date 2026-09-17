-- Convert the legacy second anonymous starter card from a second attack card
-- into the matching defense card. The predicates deliberately match only the
-- old, two-move starter-card shapes so user-created opponent notes are left
-- untouched.
WITH replacements (species_name, old_moves, new_moves) AS (
  VALUES
    ('フシギバナ', ARRAY['ギガドレイン', 'ヘドロばくだん'], ARRAY['じしん', 'ドラゴンテール']),
    ('リザードン', ARRAY['エアスラッシュ', 'かえんほうしゃ'], ARRAY['10まんボルト', 'シャドーボール']),
    ('カメックス', ARRAY['ハイドロポンプ', 'れいとうビーム'], ARRAY['ドレインパンチ', 'ドレインパンチ']),
    ('ジュカイン', ARRAY['リーフストーム', 'きあいだま'], ARRAY['れいとうパンチ', 'ウェーブタックル']),
    ('バシャーモ', ARRAY['フレアドライブ', 'インファイト'], ARRAY['ブレイブバード', 'ブレイブバード']),
    ('ラグラージ', ARRAY['じしん', 'たきのぼり'], ARRAY['じしん', 'ドラゴンテール']),
    ('メガニウム', ARRAY['タネマシンガン', 'タネマシンガン'], ARRAY['じしん', 'ドラゴンテール']),
    ('バクフーン', ARRAY['かえんほうしゃ', 'だいちのちから'], ARRAY['シャドーボール', 'ゴールドラッシュ']),
    ('オーダイル', ARRAY['じしん', 'たきのぼり'], ARRAY['ドレインパンチ', 'ドレインパンチ'])
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
  AND note.field ->> 'direction' = 'attack'
  AND jsonb_array_length(note.field -> 'attacks') = 2
  AND ARRAY(
    SELECT attack ->> 'moveName'
    FROM jsonb_array_elements(note.field -> 'attacks') WITH ORDINALITY AS moves(attack, position)
    ORDER BY position
  ) = replacements.old_moves;
