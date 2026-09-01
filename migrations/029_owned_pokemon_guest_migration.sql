-- Guest-mode account migration (docs/plan/guest_mode.md §11.2).
-- A guest browser's local Pokémon ID is retained only for migration idempotency.
ALTER TABLE owned_pokemon
  ADD COLUMN IF NOT EXISTS guest_local_id text;

-- PostgreSQL treats NULL values as distinct in a unique index.  Normal records
-- therefore remain unconstrained, while a given user's migrated guest ID can
-- only be imported once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_owned_pokemon_user_guest_local_id
  ON owned_pokemon(user_id, guest_local_id)
  WHERE guest_local_id IS NOT NULL;
