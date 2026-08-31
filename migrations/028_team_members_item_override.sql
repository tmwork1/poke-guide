-- Team-only item redistribution. NULL preserves the owned Pokemon's original item;
-- an empty string explicitly represents no item for this team member.
ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS item_override text;

CREATE OR REPLACE FUNCTION replace_team_members(
  p_user_id uuid,
  p_team_id uuid,
  p_members jsonb
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_owner_count int;
  v_total_distinct int;
  v_owned_distinct int;
BEGIN
  SELECT count(*) INTO v_owner_count
  FROM teams
  WHERE id = p_team_id AND user_id = p_user_id;

  IF v_owner_count = 0 THEN
    RAISE EXCEPTION 'team % not found or not owned by user %', p_team_id, p_user_id;
  END IF;

  WITH members AS (
    SELECT DISTINCT m.owned_pokemon_id
    FROM jsonb_to_recordset(p_members) AS m(slot int, owned_pokemon_id uuid, item_override text)
  )
  SELECT count(*), count(*) FILTER (
    WHERE EXISTS (
      SELECT 1 FROM owned_pokemon op
      WHERE op.id = members.owned_pokemon_id AND op.user_id = p_user_id
    )
  ) INTO v_total_distinct, v_owned_distinct
  FROM members;

  IF v_total_distinct <> v_owned_distinct THEN
    RAISE EXCEPTION 'one or more owned_pokemon_id do not belong to user %', p_user_id;
  END IF;

  DELETE FROM team_members WHERE team_id = p_team_id;

  INSERT INTO team_members (team_id, user_id, owned_pokemon_id, slot, item_override)
  SELECT p_team_id, p_user_id, m.owned_pokemon_id, m.slot, m.item_override
  FROM jsonb_to_recordset(p_members) AS m(slot int, owned_pokemon_id uuid, item_override text);

  UPDATE teams SET updated_at = now() WHERE id = p_team_id;
END;
$$;
