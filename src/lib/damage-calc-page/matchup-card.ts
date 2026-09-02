import { loadMoveDetailMap, loadPokemonMasterList, officialArtworkUrl, type MoveCategory } from "../pokemon-master-data";
import { registerOfflineCache } from "../pyodide-engine";
import { calculateMemberDamage, type DamageCalcDirectionResult, type DamageCalcMemberResult } from "./engine-bridge";
import { getActiveTab, getOpponentBuild, getSelectedTeam, setActiveTab, setSelectedTeam, type ActiveTab, type TeamMemberSpecInput } from "./shared-core";
import type { DamageCalcMoveInput, DamageCalcPatternKey } from "./spec-builder";

const patterns: DamageCalcPatternKey[] = ["uninvested", "invested", "specialized"];
const patternLabels = ["無振り", "32振り", "特化"];
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
interface CachedResult { result: DamageCalcMemberResult; moves: { self: DamageCalcMoveInput[]; opponent: DamageCalcMoveInput[] }; }
let resultCache = new Map<string, CachedResult>();
let calculating = false;
let revision = 0;

function selectedMember(): TeamMemberSpecInput | null {
  const team = getSelectedTeam();
  return team?.members.find((member) => member.ownedPokemon.id === team.selectedMemberId) ?? team?.members[0] ?? null;
}
function updateSelectedMember(member: TeamMemberSpecInput): void {
  const team = getSelectedTeam(); if (!team) return;
  setSelectedTeam({ ...team, selectedMemberId: member.ownedPokemon.id });
}
function setTab(tab: ActiveTab): void {
  setActiveTab(tab); render(); document.dispatchEvent(new CustomEvent("damage-calc:change", { detail: { reason: "tab" } }));
}
function renderTabs(): void {
  const active = getActiveTab();
  (["6v1", "1v1"] as ActiveTab[]).forEach((tab) => {
    const button = byId<HTMLButtonElement>(`damage-calc-tab-${tab}`); const panel = byId<HTMLElement>(`damage-calc-tabpanel-${tab}`);
    button.setAttribute("aria-selected", String(tab === active)); button.tabIndex = tab === active ? 0 : -1; panel.hidden = tab !== active;
  });
}
function renderSummary(): void {
  const opponent = getOpponentBuild(); const list = byId<HTMLElement>("damage-calc-summary-list"), placeholder = byId<HTMLElement>("damage-calc-placeholder");
  list.replaceChildren();
  if (!opponent.speciesName) { placeholder.hidden = false; return; }
  const team = getSelectedTeam();
  if (!team?.members.length) { placeholder.textContent = "チームを選択してください。"; placeholder.hidden = false; return; }
  placeholder.hidden = true;
  team.members.forEach((member) => {
    const card = document.createElement("button"); card.type = "button"; card.className = "card damage-calc-summary-card";
    const name = document.createElement("strong"); name.textContent = member.ownedPokemon.species_name;
    const item = document.createElement("span"); item.textContent = member.ownedPokemon.item_name || "もちものなし";
    const versus = document.createElement("span"); versus.textContent = `vs ${opponent.speciesName}`;
    const hint = document.createElement("small"); hint.textContent = "タップして詳細なダメージを見る";
    card.append(name, item, versus, hint);
    card.addEventListener("click", () => { updateSelectedMember(member); setTab("1v1"); }); list.append(card);
  });
}
function image(member: TeamMemberSpecInput, imageIds: Map<string, number>): HTMLButtonElement {
  const button = document.createElement("button"); button.type = "button"; button.className = "damage-calc-member-button"; button.title = member.ownedPokemon.species_name;
  const id = imageIds.get(member.ownedPokemon.species_name); if (id != null) { const img = document.createElement("img"); img.src = officialArtworkUrl(id); img.alt = member.ownedPokemon.species_name; button.append(img); } else button.textContent = member.ownedPokemon.species_name.slice(0, 1);
  button.dataset.selected = String(member.ownedPokemon.id === getSelectedTeam()?.selectedMemberId);
  button.addEventListener("click", () => { updateSelectedMember(member); resultCache.delete(member.ownedPokemon.id); render(); document.dispatchEvent(new CustomEvent("damage-calc:change", { detail: { reason: "member" } })); }); return button;
}
function row(move: DamageCalcMoveInput, direction: DamageCalcDirectionResult): HTMLTableRowElement {
  const tr = document.createElement("tr"); const head = document.createElement("th"); head.scope = "row"; head.textContent = move.moveName; tr.append(head);
  const skipped = direction.skipped.get(move.moveName);
  patterns.forEach(() => { const td = document.createElement("td");
    if (skipped === "status") td.textContent = "-";
    else if (skipped === "unsupported") td.textContent = "計算不可";
    else { const result = direction.results.get(move.moveName)?.[patterns[tr.cells.length - 1]]; td.innerHTML = result ? `<span>${result.damage}</span><small>${result.verdict}</small>` : "-"; }
    tr.append(td);
  }); return tr;
}
function table(title: string, moves: DamageCalcMoveInput[], results: DamageCalcDirectionResult): HTMLElement {
  const section = document.createElement("section"); section.className = "damage-calc-result-section"; const heading = document.createElement("h3"); heading.textContent = title;
  const wrap = document.createElement("div"); wrap.className = "damage-calc-table-wrap"; const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th>わざ</th>${patternLabels.map((label) => `<th>${label}</th>`).join("")}</tr></thead>`; const body = document.createElement("tbody"); moves.forEach((move) => body.append(row(move, results))); table.append(body); wrap.append(table); section.append(heading, wrap); return section;
}
function renderDetail(moves?: { self: DamageCalcMoveInput[]; opponent: DamageCalcMoveInput[] }): void {
  const card = byId<HTMLElement>("damage-calc-detail-card"), placeholder = byId<HTMLElement>("damage-calc-detail-placeholder"), rail = byId<HTMLElement>("damage-calc-member-rail");
  rail.replaceChildren(); const opponent = getOpponentBuild(), team = getSelectedTeam(), member = selectedMember();
  if (team) loadPokemonMasterList().then((entries) => { if (getSelectedTeam()?.id !== team.id) return; const images = new Map(entries.map((entry) => [entry.name, entry.imageId])); rail.replaceChildren(...team.members.map((item) => image(item, images))); }).catch(() => undefined);
  if (!member || !opponent.speciesName) { placeholder.hidden = false; card.hidden = true; return; }
  const cached = resultCache.get(member.ownedPokemon.id); const resolvedMoves = moves ?? cached?.moves;
  if (!cached || !resolvedMoves) { placeholder.hidden = false; placeholder.textContent = calculating ? "ダメージを計算しています…" : "ダメージ条件を読み込んでいます…"; card.hidden = true; return; }
  placeholder.hidden = true; card.hidden = false; card.replaceChildren();
  const title = document.createElement("header"); title.className = "damage-calc-card-heading";
  const own = document.createElement("div"), ownName = document.createElement("strong"), ownItem = document.createElement("span");
  ownName.textContent = member.ownedPokemon.species_name; ownItem.textContent = member.itemOverride || member.ownedPokemon.item_name || "もちものなし"; own.append(ownName, ownItem);
  const versus = document.createElement("b"); versus.textContent = "vs";
  const rival = document.createElement("div"), rivalName = document.createElement("strong"), rivalItem = document.createElement("span");
  rivalName.textContent = opponent.speciesName; rivalItem.textContent = opponent.itemName || "もちものなし"; rival.append(rivalName, rivalItem); title.append(own, versus, rival);
  const note = document.createElement("p"); note.className = "damage-calc-pattern-note"; note.textContent = "※各列は技ごとに相手の該当ステータスのみを仮定した目安です";
  card.append(title, table("攻撃", resolvedMoves.self, cached.result.attack), table("防御", resolvedMoves.opponent, cached.result.defense), note);
}
async function calculateSelected(): Promise<void> {
  if (getActiveTab() !== "1v1" || calculating) return;
  const member = selectedMember(), opponent = getOpponentBuild(); if (!member || !opponent.speciesName) return;
  const token = ++revision; calculating = true; const message = byId<HTMLElement>("damage-calc-engine-message"), error = byId<HTMLElement>("damage-calc-error"); error.hidden = true; renderDetail();
  try {
    const moveDetails = await loadMoveDetailMap();
    const mapMoves = (names: readonly string[]): DamageCalcMoveInput[] => names.flatMap((moveName) => { const detail = moveDetails.get(moveName); return detail ? [{ moveName, category: detail.category as MoveCategory }] : []; });
    const moves = { self: mapMoves(member.ownedPokemon.move_names.slice(0, 4)), opponent: mapMoves(opponent.moveNames.slice(0, 4)) };
    if (moves.self.length + moves.opponent.length === 0) { message.textContent = "計算できるわざがありません。"; return; }
    const result = await calculateMemberDamage(member, moves.self, moves.opponent, (text) => { message.textContent = text; });
    if (token !== revision) return; resultCache.set(member.ownedPokemon.id, { result, moves }); message.textContent = "計算完了"; renderDetail(moves);
  } catch (cause) {
    if (token !== revision) return; error.hidden = false; error.replaceChildren(document.createTextNode(`計算に失敗しました。${cause instanceof Error ? cause.message : ""} `)); const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "再試行"; retry.addEventListener("click", () => { void calculateSelected(); }); error.append(retry); message.textContent = "";
  } finally { if (token === revision) calculating = false; }
}
function render(): void { renderTabs(); renderSummary(); renderDetail(); if (getActiveTab() === "1v1") void calculateSelected(); }

export function initMatchupCardList(): void {
  registerOfflineCache();
  (["6v1", "1v1"] as ActiveTab[]).forEach((tab, index, tabs) => {
    const button = byId<HTMLButtonElement>(`damage-calc-tab-${tab}`);
    button.addEventListener("click", () => setTab(tab));
    button.addEventListener("keydown", (event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); const next = tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length]; setTab(next); byId<HTMLButtonElement>(`damage-calc-tab-${next}`).focus(); });
  });
  document.addEventListener("damage-calc:change", (event) => { const reason = (event as CustomEvent<{ reason?: string }>).detail?.reason; if (reason !== "tab") { revision += 1; calculating = false; render(); } }); render();
}
