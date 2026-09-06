import { listTeamsPage } from "../data/team-repo";
import { bindModalDismissal } from "../modal-dismiss";
import { renderTeamCard } from "../team-card";
import type { Team, TeamMember } from "../team";
import { setSelfBuilds, type SelfBuild } from "./shared-core";

const PAGE_SIZE = 48;

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function toSelfBuild(member: TeamMember): SelfBuild {
  const pokemon = member.owned_pokemon;
  return {
    id: pokemon.id,
    species_name: pokemon.species_name,
    level: pokemon.level,
    nature: pokemon.nature,
    ability_name: pokemon.ability_name,
    item_name: member.item_override ?? pokemon.item_name,
    tera_type: pokemon.tera_type,
    evs: pokemon.evs,
    ivs: pokemon.ivs,
    move_names: pokemon.move_names,
  };
}

export function initTeamSelectDialog(): void {
  const trigger = byId<HTMLButtonElement>("damage-calc-team-button");
  const backdrop = byId<HTMLElement>("damage-calc-team-select-backdrop");
  const dialog = byId<HTMLElement>("damage-calc-team-select-dialog");
  const closeButton = byId<HTMLButtonElement>(
    "damage-calc-team-select-close-button",
  );
  const grid = byId<HTMLElement>("damage-calc-team-select-grid");
  const loading = byId<HTMLElement>("damage-calc-team-select-loading");
  const error = byId<HTMLElement>("damage-calc-team-select-error");
  const empty = byId<HTMLElement>("damage-calc-team-select-empty");
  let cachedTeams: Team[] | null = null;
  let loadingPromise: Promise<void> | null = null;

  function closeDialog(): void {
    backdrop.hidden = true;
    dialog.hidden = true;
    trigger.focus();
  }

  function selectTeam(team: Team): void {
    setSelfBuilds(team.members.map(toSelfBuild));
    document.dispatchEvent(
      new CustomEvent("damage-calc:change", { detail: { reason: "self" } }),
    );
    closeDialog();
  }

  function renderList(teams: Team[]): void {
    grid.replaceChildren(
      ...teams.map((team) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "damage-calc-team-select-card-button";
        const memoText = (team.memo ?? "").trim();
        const membersBySlot = new Map(
          team.members.map((member) => [member.slot, member]),
        );
        button.append(
          renderTeamCard({
            name: "",
            memo: memoText
              ? { text: "📝", title: memoText, ariaLabel: `メモ: ${memoText}` }
              : {},
            badges: [
              {
                className: "badge tnum card-team-count-badge",
                text: `${team.members.length}/6`,
              },
            ],
            membersBySlot,
            toCardContent: (member) => {
              const pokemonName =
                member.owned_pokemon.species_name?.trim() || "ポケモン";
              return {
                pokemon: member.owned_pokemon,
                displayName: pokemonName,
                ariaLabel: pokemonName,
              };
            },
          }),
        );
        button.addEventListener("click", () => selectTeam(team));
        return button;
      }),
    );
    empty.hidden = teams.length !== 0;
  }

  async function loadList(): Promise<void> {
    if (cachedTeams) {
      renderList(cachedTeams);
      return;
    }
    if (loadingPromise) return loadingPromise;
    loading.hidden = false;
    error.hidden = true;
    empty.hidden = true;
    loadingPromise = (async () => {
      const teams: Team[] = [];
      let hasMore = true;
      while (hasMore) {
        const page = await listTeamsPage({
          limit: PAGE_SIZE,
          offset: teams.length,
        });
        teams.push(...page.teams);
        hasMore = page.hasMore && page.teams.length > 0;
        if (hasMore && page.teams.length > 0) {
          await new Promise<void>((resolve) =>
            window.requestAnimationFrame(() => resolve()),
          );
        }
      }
      cachedTeams = teams;
      renderList(teams);
    })()
      .catch((cause: unknown) => {
        console.error(cause);
        error.textContent =
          "チームを読み込めませんでした。時間をおいて再度お試しください。";
        error.hidden = false;
      })
      .finally(() => {
        loading.hidden = true;
        loadingPromise = null;
      });
    return loadingPromise;
  }

  async function openDialog(): Promise<void> {
    backdrop.hidden = false;
    dialog.hidden = false;
    dialog.focus();
    await loadList();
  }

  trigger.addEventListener("click", () => void openDialog());
  closeButton.addEventListener("click", closeDialog);
  bindModalDismissal({
    backdrop,
    dialog,
    isOpen: () => !dialog.hidden,
    onDismiss: closeDialog,
  });
}
