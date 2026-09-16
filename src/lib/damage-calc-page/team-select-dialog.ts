import { listTeamsPage } from "../data/team-repo";
import { bindModalDismissal } from "../modal-dismiss";
import { renderTeamCard } from "../team-card";
import { renderTeamMateSlots } from "../team-mate-card";
import type { Team, TeamMember } from "../team";
import { kanaIncludes } from "../kana";
import { splitSearchTokens } from "../search-tokens";
import {
  toggleDensityMode,
  updateDensityToggleButton,
  type DisplayDensityMode,
} from "../display-density-toggle";
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

// チーム選択ダイアログとURL引き継ぎのどちらから選んでも、個体→計算用ビルドの
// 変換・状態更新・再計算通知が完全に同じ順序になるよう、選択結果の適用はここに集約する。
export function selectTeam(team: Team): void {
  setSelfBuilds(team.members.map(toSelfBuild));
  // 対面カードの初期描画は同期処理を含むため、次フレームで通知してモーダルを先に描画から外す。
  window.requestAnimationFrame(() => {
    document.dispatchEvent(
      new CustomEvent("damage-calc:change", { detail: { reason: "self" } }),
    );
  });
}

// ゲスト時もlistTeamsPage()がlocalStorageのチームを返すため、URLからの復元でも
// ダイアログと同じ取得経路を通す。個別APIを使わず全ページをたどることで、
// ページ境界より後にあるチームIDも取りこぼさない。
export async function findTeamById(teamId: string): Promise<Team | null> {
  let offset = 0;
  let hasMore = true;
  while (hasMore) {
    const page = await listTeamsPage({ limit: PAGE_SIZE, offset });
    const team = page.teams.find((candidate) => candidate.id === teamId);
    if (team) return team;
    hasMore = page.hasMore && page.teams.length > 0;
    offset += page.teams.length;
  }
  return null;
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
  const searchInput = byId<HTMLInputElement>("damage-calc-team-select-search-input");
  const densityToggle = byId<HTMLButtonElement>("damage-calc-team-select-density-toggle");
  let cachedTeams: Team[] | null = null;
  let loadingPromise: Promise<void> | null = null;
  let searchQuery = "";
  let displayMode: DisplayDensityMode = "expanded";

  function closeDialog(): void {
    backdrop.hidden = true;
    dialog.hidden = true;
    trigger.focus();
  }

  // /team 一覧と同じく、メンバーの種族名・もちもの・わざを対象にしたAND部分一致検索。
  function filterBySearch(teams: Team[]): Team[] {
    const tokens = splitSearchTokens(searchQuery);
    if (tokens.length === 0) return teams;
    return teams.filter((team) => {
      const haystack = [
        ...team.members.map((m) => m.owned_pokemon.species_name ?? ""),
        ...team.members.map((m) => m.owned_pokemon.item_name ?? ""),
        ...team.members.flatMap((m) => m.owned_pokemon.move_names ?? []),
      ].join(" ");
      return tokens.every((token) => kanaIncludes(haystack, token));
    });
  }

  function renderCurrentList(): void {
    if (cachedTeams) renderList(filterBySearch(cachedTeams));
  }

  function updateDensityToggleUi(): void {
    updateDensityToggleButton(densityToggle, displayMode);
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
            // 圧縮表示は /team 一覧と同じ6枠ミニサムネイル(.team-mate-grid)。
            // item_overrideがあれば個体登録値より優先して表示する。
            renderMembers: displayMode === "compressed"
              ? (container) => {
                  container.className = "team-mate-grid";
                  const mateMembersBySlot = new Map(team.members.map((m) => {
                    const itemName = (m.item_override ?? m.owned_pokemon.item_name ?? "").trim();
                    return [m.slot, { ...m.owned_pokemon, item_name: itemName || null }];
                  }));
                  renderTeamMateSlots({
                    root: container,
                    membersBySlot: mateMembersBySlot,
                    displayName: (p) => p.species_name || "ポケモン",
                  });
                }
              : undefined,
          }),
        );
        button.addEventListener("click", () => {
          closeDialog();
          selectTeam(team);
        });
        return button;
      }),
    );
    empty.hidden = teams.length !== 0;
  }

  async function loadList(): Promise<void> {
    if (cachedTeams) {
      renderCurrentList();
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
      renderCurrentList();
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
    searchQuery = "";
    searchInput.value = "";
    backdrop.hidden = false;
    dialog.hidden = false;
    dialog.focus();
    await loadList();
  }

  trigger.addEventListener("click", () => void openDialog());
  closeButton.addEventListener("click", closeDialog);
  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value.trim();
    renderCurrentList();
  });
  densityToggle.addEventListener("click", () => {
    displayMode = toggleDensityMode(displayMode);
    updateDensityToggleUi();
    renderCurrentList();
  });
  updateDensityToggleUi();
  bindModalDismissal({
    backdrop,
    dialog,
    isOpen: () => !dialog.hidden,
    onDismiss: closeDialog,
  });
}
