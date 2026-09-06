import { describeStandaloneLethal, formatDamageRange } from "../box-id/damage-calc-helpers";
import { championSpriteUrl, loadImageIdMap, loadMoveDetailMap, officialArtworkUrl, type MoveCategory } from "../pokemon-master-data";
import { calcDamages, calcStats, initEngine, registerOfflineCache, type PokemonSpec } from "../pyodide-engine";
import { NATURE_STAT_MODIFIERS, STAT_KEYS, type StatKey } from "../stats";
import { pickOpponentAttackMoves, type PopularMoveOption } from "../team-matchup";
import { getFieldState, getOpponentBuild, getOpponentState, getSelfBuild, getSelfState, type OpponentBuild, type SelfBuild } from "./shared-core";

type DamageCell = { range: string; lethal: string };
type DamageRow = { moveName: string; cells: DamageCell[] };

const CHANGE_EVENT = "damage-calc:change";
const DEFAULT_OPPONENT = "サーフゴー";
const PATTERN_LABELS = ["無振り", "32振り", "特化"];
let timer: number | undefined;
let requestId = 0;
let opponentMovesCache = new Map<string, Promise<PopularMoveOption[]>>();

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function isSelectedSelf(build: SelfBuild): boolean {
  return build.species_name.trim() !== "";
}

function natureWithRaisedStat(stat: StatKey): string {
  return Object.entries(NATURE_STAT_MODIFIERS).find(([, modifier]) => modifier.up === stat)?.[0] ?? "まじめ";
}

function evsWith(stat: StatKey, amount: number): number[] {
  const evs = [0, 0, 0, 0, 0, 0];
  evs[STAT_KEYS.indexOf(stat)] = amount;
  return evs;
}

function selfSpec(build: SelfBuild): PokemonSpec {
  const state = getSelfState();
  const moveNames = build.move_names.map((name) => name.trim()).filter(Boolean).slice(0, 4);
  return {
    name: build.species_name,
    level: build.level ?? 50,
    nature: build.nature ?? "まじめ",
    abilityName: build.ability_name ?? "",
    itemName: build.item_name ?? "",
    moveNames,
    teraType: state.teraType || build.tera_type || null,
    terastallized: state.teraType !== "",
    evs: build.evs,
    ivs: build.ivs,
    boosts: state.boosts,
    ailment: state.ailment,
  };
}

function opponentSpec(build: OpponentBuild, moveNames: string[], nature: string, evs: number[]): PokemonSpec {
  const state = getOpponentState();
  return {
    name: build.speciesName || DEFAULT_OPPONENT,
    level: 50,
    nature,
    abilityName: "",
    itemName: build.itemName ?? "",
    moveNames,
    teraType: state.teraType || null,
    terastallized: state.teraType !== "",
    evs,
    ivs: [31, 31, 31, 31, 31, 31],
    boosts: state.boosts,
    ailment: state.ailment,
  };
}

function opponentPatterns(build: OpponentBuild, moveNames: string[], stat: StatKey): PokemonSpec[] {
  return [
    opponentSpec(build, moveNames, "まじめ", evsWith(stat, 0)),
    opponentSpec(build, moveNames, "まじめ", evsWith(stat, 32)),
    opponentSpec(build, moveNames, natureWithRaisedStat(stat), evsWith(stat, 32)),
  ];
}

function statForCategory(category: MoveCategory, direction: "attack" | "defense"): StatKey | null {
  if (category === "status") return null;
  if (direction === "attack") return category === "physical" ? "def" : "spd";
  return category === "physical" ? "atk" : "spa";
}

async function fetchOpponentMoveOptions(speciesName: string): Promise<PopularMoveOption[]> {
  let cached = opponentMovesCache.get(speciesName);
  if (!cached) {
    cached = fetch(`/api/opgg-usage?species=${encodeURIComponent(speciesName)}&category=moves`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`相手技の使用率取得に失敗しました (${response.status})`);
        const body = await response.json() as { options?: { name: string; usageRate: number | null }[] };
        return (body.options ?? [])
          .filter((option) => option.usageRate != null)
          .map((option) => ({ value: option.name, ratio: (option.usageRate ?? 0) / 100 }));
      })
      .catch((error: unknown) => {
        opponentMovesCache.delete(speciesName);
        throw error;
      });
    opponentMovesCache.set(speciesName, cached);
  }
  return cached;
}

function setStatus(message: string | null, isError = false): void {
  const status = byId<HTMLElement>("damage-calc-matchup-status");
  status.hidden = message === null;
  status.textContent = message ?? "";
  status.dataset.state = isError ? "error" : "loading";
}

function renderArtwork(id: string, name: string, imageId: number | undefined): void {
  const root = byId<HTMLElement>(id);
  root.replaceChildren();
  root.setAttribute("aria-label", name || "?");
  if (!name || imageId == null) {
    root.classList.add("damage-calc-matchup-card__artwork--placeholder");
    const placeholder = document.createElement("span");
    placeholder.textContent = "?";
    root.append(placeholder);
    return;
  }
  root.classList.remove("damage-calc-matchup-card__artwork--placeholder");
  const image = document.createElement("img");
  image.src = championSpriteUrl(imageId);
  image.alt = name;
  image.onerror = () => {
    image.onerror = null;
    image.src = officialArtworkUrl(imageId);
  };
  root.append(image);
}

function renderIdentity(self: SelfBuild, opponent: OpponentBuild, currentRequestId: number): void {
  const selfName = self.species_name.trim();
  const opponentName = opponent.speciesName || DEFAULT_OPPONENT;
  byId<HTMLElement>("damage-calc-matchup-title").textContent = selfName || "?";
  byId<HTMLElement>("damage-calc-opponent-name").textContent = opponentName;
  void loadImageIdMap().then((imageIds) => {
    if (currentRequestId !== requestId) return;
    renderArtwork("damage-calc-self-artwork", selfName, imageIds.get(selfName));
    renderArtwork("damage-calc-opponent-artwork", opponentName, imageIds.get(opponentName));
  }).catch(() => {
    if (currentRequestId !== requestId) return;
    renderArtwork("damage-calc-self-artwork", selfName, undefined);
    renderArtwork("damage-calc-opponent-artwork", opponentName, undefined);
  });
}

function makeCell(range: string, lethal: string): HTMLTableCellElement {
  const cell = document.createElement("td");
  const strong = document.createElement("strong");
  strong.textContent = range;
  const small = document.createElement("small");
  small.textContent = lethal;
  cell.append(strong, small);
  return cell;
}

function renderTable(containerId: string, label: "攻" | "守", rows: DamageRow[]): void {
  const wrap = document.createElement("div");
  wrap.className = "damage-calc-matchup-card__table-wrap";
  const table = document.createElement("table");
  table.className = "damage-calc-matchup-card__table";
  const colgroup = document.createElement("colgroup");
  const firstCol = document.createElement("col");
  firstCol.className = "damage-calc-matchup-card__move-column";
  colgroup.append(firstCol, document.createElement("col"), document.createElement("col"), document.createElement("col"));
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  const labelHeader = document.createElement("th");
  labelHeader.scope = "col";
  const labelSpan = document.createElement("span");
  labelSpan.className = `damage-calc-matchup-card__table-label damage-calc-matchup-card__table-label--${label === "攻" ? "attack" : "defense"}`;
  labelSpan.textContent = label;
  labelHeader.append(labelSpan);
  headerRow.append(labelHeader, ...PATTERN_LABELS.map((text) => {
    const header = document.createElement("th");
    header.scope = "col";
    header.textContent = text;
    return header;
  }));
  thead.append(headerRow);
  const tbody = document.createElement("tbody");
  if (rows.length === 0) {
    const row = document.createElement("tr");
    const header = document.createElement("th");
    header.scope = "row";
    header.textContent = "-";
    row.append(header, ...PATTERN_LABELS.map(() => makeCell("-", "")));
    tbody.append(row);
  } else {
    for (const result of rows) {
      const row = document.createElement("tr");
      const header = document.createElement("th");
      header.scope = "row";
      header.textContent = result.moveName;
      row.append(header, ...result.cells.map((cell) => makeCell(cell.range, cell.lethal)));
      tbody.append(row);
    }
  }
  table.append(colgroup, thead, tbody);
  wrap.append(table);
  byId<HTMLElement>(containerId).replaceChildren(wrap);
}

function renderSpeed(selfSpeed: number | null, opponentSpeeds: number[]): void {
  const root = document.createElement("div");
  root.className = "damage-calc-matchup-card__speed";
  const selfGroup = document.createElement("div");
  selfGroup.className = "damage-calc-matchup-card__speed-group damage-calc-matchup-card__speed-group--self";
  const opponentGroup = document.createElement("div");
  opponentGroup.className = "damage-calc-matchup-card__speed-group damage-calc-matchup-card__speed-group--opponent";
  const makeItem = (label: string, value: number | null): HTMLDivElement => {
    const item = document.createElement("div");
    item.className = "damage-calc-matchup-card__speed-item";
    const itemLabel = document.createElement("span");
    itemLabel.className = "damage-calc-matchup-card__speed-label";
    itemLabel.textContent = label;
    const itemValue = document.createElement("span");
    itemValue.className = "damage-calc-matchup-card__speed-value tnum";
    itemValue.textContent = value?.toString() ?? "-";
    item.append(itemLabel, itemValue);
    return item;
  };
  selfGroup.append(makeItem("すばやさ", selfSpeed));
  opponentGroup.append(...["無振り", "準速", "最速"].map((label, index) => makeItem(label, opponentSpeeds[index] ?? null)));
  root.append(selfGroup, opponentGroup);
  byId<HTMLElement>("damage-calc-matchup-speed").replaceChildren(root);
}

function percentageOnly(damages: number[], hp: number): string {
  const formatted = formatDamageRange(damages, hp);
  return formatted.match(/\((.+)\)$/)?.[1] ?? "-";
}

async function calculateAttackRows(self: PokemonSpec, opponent: OpponentBuild, moveNames: string[], categories: Map<string, MoveCategory>): Promise<DamageRow[]> {
  const fieldState = getFieldState();
  const defenderStats = new Map<string, Promise<number>>();
  const rows: DamageRow[] = [];
  for (const moveName of moveNames) {
    const stat = statForCategory(categories.get(moveName) ?? "status", "attack");
    if (!stat) continue;
    const defenders = opponentPatterns(opponent, [], stat);
    const cells: DamageCell[] = [];
    for (const defender of defenders) {
      const cacheKey = `${stat}:${defender.nature}:${defender.evs?.join(",")}`;
      let hp = defenderStats.get(cacheKey);
      if (!hp) {
        hp = calcStats(defender).then((result) => result.stats.hp);
        defenderStats.set(cacheKey, hp);
      }
      const [result, defenderHp] = await Promise.all([
        calcDamages(self, defender, moveName, { field: { weather: fieldState.weather || undefined, terrain: fieldState.terrain || undefined, defenderSideFields: fieldState.opponentSideFields }, critical: false }),
        hp,
      ]);
      cells.push({ range: percentageOnly(result.damages, defenderHp), lethal: describeStandaloneLethal(result.damages, defenderHp).label });
    }
    rows.push({ moveName, cells });
  }
  return rows;
}

async function calculateDefenseRows(self: PokemonSpec, opponent: OpponentBuild, moveNames: string[], categories: Map<string, MoveCategory>): Promise<DamageRow[]> {
  const selfHp = (await calcStats(self)).stats.hp;
  const fieldState = getFieldState();
  const rows: DamageRow[] = [];
  for (const moveName of moveNames) {
    const stat = statForCategory(categories.get(moveName) ?? "status", "defense");
    if (!stat) continue;
    const attackers = opponentPatterns(opponent, moveNames, stat);
    const cells: DamageCell[] = [];
    for (const attacker of attackers) {
      const result = await calcDamages(attacker, self, moveName, { field: { weather: fieldState.weather || undefined, terrain: fieldState.terrain || undefined, defenderSideFields: fieldState.selfSideFields }, critical: false });
      cells.push({ range: percentageOnly(result.damages, selfHp), lethal: describeStandaloneLethal(result.damages, selfHp).label });
    }
    rows.push({ moveName, cells });
  }
  return rows;
}

async function run(): Promise<void> {
  const currentRequestId = ++requestId;
  const selfBuild = getSelfBuild();
  const currentOpponent = getOpponentBuild();
  const opponent: OpponentBuild = { ...currentOpponent, speciesName: currentOpponent.speciesName || DEFAULT_OPPONENT };
  renderIdentity(selfBuild, opponent, currentRequestId);
  setStatus("ダメージを計算中…");
  renderSpeed(null, []);
  renderTable("damage-calc-matchup-attack-table", "攻", []);
  renderTable("damage-calc-matchup-defense-table", "守", []);
  try {
    const [moveDetails, usageOptions] = await Promise.all([loadMoveDetailMap(), fetchOpponentMoveOptions(opponent.speciesName)]);
    if (currentRequestId !== requestId) return;
    const categoryOf = (moveName: string): MoveCategory => moveDetails.get(moveName)?.category ?? "status";
    const isAttackMove = (moveName: string): boolean => categoryOf(moveName) !== "status";
    const selfMoveNames = selfBuild.move_names.map((name) => name.trim()).filter(Boolean).slice(0, 4).filter(isAttackMove);
    // 相性チェック側の共有ヘルパーは全候補を返すため、実機の4技枠に合わせる表示側で上限を適用する。
    const opponentMoveNames = pickOpponentAttackMoves(usageOptions, isAttackMove).slice(0, 4);
    registerOfflineCache();
    await initEngine();
    if (currentRequestId !== requestId) return;
    const speedSpecs = opponentPatterns(opponent, [], "spe");
    const opponentSpeeds: number[] = [];
    for (const spec of speedSpecs) opponentSpeeds.push((await calcStats(spec)).stats.spe);
    const self = isSelectedSelf(selfBuild) ? selfSpec(selfBuild) : null;
    const selfSpeed = self ? (await calcStats(self)).stats.spe : null;
    if (currentRequestId !== requestId) return;
    renderSpeed(selfSpeed, opponentSpeeds);
    const categories = new Map<string, MoveCategory>([...selfMoveNames, ...opponentMoveNames].map((name) => [name, categoryOf(name)]));
    const attackRows = self ? await calculateAttackRows(self, opponent, selfMoveNames, categories) : [];
    const defenseRows = self ? await calculateDefenseRows(self, opponent, opponentMoveNames, categories) : opponentMoveNames.map((moveName) => ({ moveName, cells: PATTERN_LABELS.map(() => ({ range: "-", lethal: "" })) }));
    if (currentRequestId !== requestId) return;
    renderTable("damage-calc-matchup-attack-table", "攻", attackRows);
    renderTable("damage-calc-matchup-defense-table", "守", defenseRows);
    setStatus(null);
  } catch (error) {
    console.error(error);
    if (currentRequestId !== requestId) return;
    setStatus("ダメージを計算できませんでした。再度お試しください。", true);
  }
}

export function initMatchupCardList(): void {
  document.addEventListener(CHANGE_EVENT, () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(), 700);
  });
  void run();
}
