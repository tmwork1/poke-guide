import { describeStandaloneLethal } from "../box-id/damage-calc-helpers";
import { splitBoxCardDisplayName } from "../box-card-display-name";
import { championSpriteUrl, loadImageIdMap, loadMegaStoneMap, loadMoveDetailMap, loadPokemonMasterList, officialArtworkUrl, type MoveCategory, type PokemonMasterEntry } from "../pokemon-master-data";
import { calcDamages, calcStats, initEngine, registerOfflineCache, type PokemonSpec } from "../pyodide-engine";
import { loadItemSpriteMap } from "../sprite-urls";
import { NATURE_STAT_MODIFIERS, STAT_KEYS, type StatKey } from "../stats";
import type { PopularMoveOption } from "../team-matchup";
import { openBoxSelectDialog } from "./box-select-dialog";
import { renderItemIcon } from "./item-select-dialog";
import { readJsonScriptStringArray } from "../json-script";
import { getFieldState, getOpponentBuild, getOpponentState, getSelfBuilds, getSelfState, setOpponentBuild, type OpponentBuild, type SelfBuild } from "./shared-core";

type DamageCell = { range: string; lethal: string };
type DamageRow = { moveName: string; cells: DamageCell[] };
type PopularAbilityOption = { value: string; ratio: number };
/** 1枚の対面カード(自分側1体ぶん)のDOM参照。テンプレートを複製するたびにこの形で1組作る。 */
type CardRefs = {
  selfArtwork: HTMLElement;
  matchupTitle: HTMLElement;
  selfItemButton: HTMLButtonElement;
  selfItemIcon: HTMLImageElement;
  selfItemNoneIcon: Element;
  opponentArtwork: HTMLElement;
  opponentName: HTMLElement;
  opponentItemIcon: HTMLImageElement;
  opponentItemNoneIcon: Element;
  opponentAbilityButton: HTMLButtonElement;
  status: HTMLElement;
  speed: HTMLElement;
  attackTable: HTMLElement;
  defenseTable: HTMLElement;
};
/** 自分側1体ぶんのカードDOMと、その計算対象のビルド。 */
type Card = { build: SelfBuild; root: HTMLElement; refs: CardRefs };

const CHANGE_EVENT = "damage-calc:change";
const emitChange = (reason: string) => document.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { reason } }));
/** デフォルトの相手はopgg採用率1位のポケモン(index.astroが埋め込むJSONの先頭)。
 * データが読めない場合のみ固定名にフォールバックする。 */
let defaultOpponentCache: string | null = null;
function getDefaultOpponentName(): string {
  if (defaultOpponentCache === null) defaultOpponentCache = readJsonScriptStringArray("damage-calc-opgg-ranked-species")[0] ?? "サーフゴー";
  return defaultOpponentCache;
}
const PATTERN_LABELS = ["無振り", "32振り", "特化"];
/** 対面カードの防御表に載せる相手技の採用率しきい値(このカード専用。team-matchup.tsの
 * OPPONENT_MIN_MOVE_RATIO(20%)と閾値は同じだが、あちらの上限4本は適用しない要件のため
 * 共有定数は変更せずここで別途定義する)。 */
const OPPONENT_DEFENSE_MOVE_MIN_RATIO = 0.2;
/** すばやさを常時・無条件に固定倍率で変動させる持ち物(4096基準の固定小数点)。
 * jpokeの`vendor/jpoke/src/jpoke/handlers/item.py`準拠(こだわりスカーフ_boost_speed / くろいてっきゅう_halve_speed)。
 * カムラのみ・からぶりほけん等、HP残量や特定の行動が条件の発動アイテムはここに含めない
 * (対面カードは常在効果のみを表示用に補正する)。calcStats()の実数値は持ち物補正を
 * 含まないため、表示用にここで別途掛け合わせる。 */
const SPEED_MODIFIER_ITEMS: Record<string, number> = {
  "こだわりスカーフ": 6144,
  "くろいてっきゅう": 2048,
};
const FIXED_POINT_BASE = 4096;

function applySpeedItemModifier(speed: number, itemName: string | null | undefined): number {
  const modifier = itemName ? SPEED_MODIFIER_ITEMS[itemName] : undefined;
  return modifier ? Math.floor((speed * modifier) / FIXED_POINT_BASE) : speed;
}
let timer: number | undefined;
let requestId = 0;
let opponentMovesCache = new Map<string, Promise<PopularMoveOption[]>>();
let opponentAbilitiesCache = new Map<string, Promise<PopularAbilityOption[]>>();

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** テンプレート(MatchupCardList.astro)から`data-role`要素を1つ引く。カードのルート単位で
 * スコープするため、`byId`と違って同じ`data-role`がカードの枚数ぶんあっても衝突しない。 */
function role<T extends HTMLElement>(root: HTMLElement, name: string): T {
  return root.querySelector<T>(`[data-role="${name}"]`) as T;
}

function isSelectedSelf(build: SelfBuild): boolean {
  return build.species_name.trim() !== "";
}

const isMegaEntry = (entry: PokemonMasterEntry): boolean => entry.forme?.startsWith("Mega") ?? false;

/** メガシンカ後の種族に対応するメガストーン名を返す(該当しない/items.jsonに実在しないアイテムは
 * null)。box-id/shared-core.tsのresolveMegaStoneItemと同じロジックだが、あちらはbox/[id].astro
 * 専用のDOM前提を持つモジュールのためここでは使わず、pokemon-master-data.ts/sprite-urls.tsから
 * 直接組み立てる(loadMegaStoneMapのコメントにある「items.jsonに存在しないメガストーン名」の
 * 既知の不整合を弾く)。 */
async function resolveOpponentMegaStoneItem(speciesName: string): Promise<string | null> {
  const [megaStoneMap, itemSpriteMap] = await Promise.all([loadMegaStoneMap(), loadItemSpriteMap()]);
  const stoneName = megaStoneMap.get(speciesName);
  if (!stoneName || !itemSpriteMap.has(stoneName)) return null;
  return stoneName;
}

/** 相手の立ち絵タップ: そのポケモンがメガシンカ可能・済みなら、同じ図鑑番号内の
 * 「通常→メガ→(メガX/Yなど複数あれば続けて)…→通常」の順で次のフォルムへ循環させる。
 * メガシンカ不可の種族はタップしても何も起きない。メガへ切り替えた場合は、もちものを
 * 対応するメガストーンに固定する(通常フォルムへ戻すときはもちものを変更しない)。 */
async function cycleOpponentForm(): Promise<void> {
  const master = await loadPokemonMasterList();
  const current = getOpponentBuild();
  const currentName = current.speciesName || getDefaultOpponentName();
  const currentEntry = master.find((entry) => entry.name === currentName);
  if (!currentEntry) return;
  const forms = master.filter((entry) => entry.dexNo === currentEntry.dexNo && (entry.forme === null || isMegaEntry(entry)));
  if (forms.length <= 1) return;
  const currentIndex = forms.findIndex((entry) => entry.name === currentName);
  const next = forms[(currentIndex + 1) % forms.length];
  const nextItemName = isMegaEntry(next) ? (await resolveOpponentMegaStoneItem(next.name)) ?? current.itemName : current.itemName;
  setOpponentBuild({ ...current, speciesName: next.name, abilityName: "", itemName: nextItemName });
  emitChange("opponent");
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
    name: build.speciesName || getDefaultOpponentName(),
    level: 50,
    nature,
    abilityName: build.abilityName ?? "",
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

/** 防御表(相手のわざ)に載せる技名を、OP.GG採用率20%以上のものすべて(上限なし)から選ぶ。 */
function pickOpponentDefenseMoves(options: readonly PopularMoveOption[], isAttackMove: (moveName: string) => boolean): string[] {
  const attacks = options.filter((option) => option.ratio >= OPPONENT_DEFENSE_MOVE_MIN_RATIO && isAttackMove(option.value));
  const sorted = [...attacks].sort((a, b) => b.ratio - a.ratio);
  const picked: string[] = [];
  for (const option of sorted) {
    if (picked.includes(option.value)) continue;
    picked.push(option.value);
  }
  return picked;
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

async function fetchOpponentAbilityOptions(speciesName: string): Promise<PopularAbilityOption[]> {
  let cached = opponentAbilitiesCache.get(speciesName);
  if (!cached) {
    cached = fetch(`/api/opgg-usage?species=${encodeURIComponent(speciesName)}&category=abilities`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`相手特性の使用率取得に失敗しました (${response.status})`);
        const body = await response.json() as { options?: { name: string; usageRate: number | null }[] };
        return (body.options ?? [])
          .filter((option) => option.usageRate != null && option.usageRate >= 10)
          .map((option) => ({ value: option.name, ratio: (option.usageRate ?? 0) / 100 }))
          .sort((a, b) => b.ratio - a.ratio);
      })
      .catch((error: unknown) => {
        opponentAbilitiesCache.delete(speciesName);
        throw error;
      });
    opponentAbilitiesCache.set(speciesName, cached);
  }
  return cached;
}

function setStatus(status: HTMLElement, message: string | null, isError = false): void {
  status.hidden = message === null;
  status.textContent = message ?? "";
  status.dataset.state = isError ? "error" : "loading";
}

function renderArtwork(root: HTMLElement, name: string, imageId: number | undefined): void {
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

function renderName(h2: HTMLElement, name: string): void {
  h2.replaceChildren();
  if (!name) return;
  const { name: mainName, suffix } = splitBoxCardDisplayName(name);
  const mainEl = document.createElement("span");
  mainEl.className = "damage-calc-matchup-card__pokemon-name-main";
  mainEl.textContent = mainName;
  h2.append(mainEl);
  if (suffix) {
    const suffixEl = document.createElement("span");
    suffixEl.className = "damage-calc-matchup-card__pokemon-name-suffix";
    suffixEl.textContent = suffix;
    h2.append(suffixEl);
  }
}

/** テンプレートを複製して1枚ぶんのカードDOMを組み立てる。`index`は`getSelfBuilds()`配列の
 * 添字で、もちもの選択(item-select-dialog.ts)がどのカードのクリックかを判定するために
 * トリガー要素の`data-damage-calc-card-index`へも書き込む。 */
function createCard(index: number): { root: HTMLElement; refs: CardRefs } {
  const template = byId<HTMLTemplateElement>("damage-calc-matchup-card-template");
  const fragment = template.content.cloneNode(true) as DocumentFragment;
  const root = fragment.firstElementChild as HTMLElement;
  root.dataset.damageCalcCardIndex = String(index);
  const selfItemButton = root.querySelector<HTMLButtonElement>('[data-damage-calc-item-side="self"]') as HTMLButtonElement;
  const opponentAbilityButton = document.createElement("button");
  opponentAbilityButton.type = "button";
  opponentAbilityButton.className = "damage-calc-matchup-card__opponent-ability";
  opponentAbilityButton.hidden = true;
  role<HTMLElement>(root, "opponent-artwork").parentElement?.append(opponentAbilityButton);
  selfItemButton.dataset.damageCalcCardIndex = String(index);
  const refs: CardRefs = {
    selfArtwork: role(root, "self-artwork"),
    matchupTitle: role(root, "matchup-title"),
    selfItemButton,
    selfItemIcon: role(root, "self-item-icon"),
    selfItemNoneIcon: role(root, "self-item-none-icon"),
    opponentArtwork: role(root, "opponent-artwork"),
    opponentName: role(root, "opponent-name"),
    opponentItemIcon: role(root, "opponent-item-icon"),
    opponentItemNoneIcon: role(root, "opponent-item-none-icon"),
    opponentAbilityButton,
    status: role(root, "matchup-status"),
    speed: role(root, "matchup-speed"),
    attackTable: role(root, "matchup-attack-table"),
    defenseTable: role(root, "matchup-defense-table"),
  };
  // 自分側の立ち絵タップでボックス選択モーダルを開く導線は、カードが何枚あっても共通
  // (選ぶと box-select-dialog.ts 側で自分側カードは常に1枚へ戻る)。
  refs.selfArtwork.addEventListener("click", () => openBoxSelectDialog());
  // 相手側の立ち絵タップはメガシンカフォルムの循環切り替え(カードが何枚あっても相手は共通)。
  refs.opponentArtwork.addEventListener("click", () => void cycleOpponentForm());
  opponentAbilityButton.addEventListener("click", () => {
    const abilities = (opponentAbilityButton.dataset.abilities ?? "").split("\u001f").filter(Boolean);
    if (abilities.length === 0) return;
    const current = getOpponentBuild();
    const nextIndex = (abilities.indexOf(current.abilityName) + 1) % abilities.length;
    setOpponentBuild({ ...current, abilityName: abilities[nextIndex] });
    emitChange("opponent-ability");
  });
  return { root, refs };
}

function renderOpponentAbility(refs: CardRefs, abilityOptions: readonly PopularAbilityOption[], abilityName: string): void {
  const abilityNames = abilityOptions.map((option) => option.value);
  const button = refs.opponentAbilityButton;
  button.hidden = abilityNames.length === 0;
  button.dataset.abilities = abilityNames.join("\u001f");
  button.textContent = abilityName;
  button.ariaLabel = `相手の特性: ${abilityName}。タップで切り替え`;
}

function renderIdentity(refs: CardRefs, self: SelfBuild, opponent: OpponentBuild, currentRequestId: number): void {
  const selfSelected = isSelectedSelf(self);
  const selfName = self.species_name.trim();
  const opponentName = opponent.speciesName || getDefaultOpponentName();
  renderName(refs.matchupTitle, selfSelected ? selfName : "");
  renderName(refs.opponentName, opponentName);
  refs.selfItemButton.hidden = !selfSelected;
  if (selfSelected) renderItemIcon(refs.selfItemIcon, refs.selfItemNoneIcon, self.item_name ?? "");
  else {
    refs.selfItemIcon.hidden = true;
    refs.selfItemNoneIcon.setAttribute("hidden", "");
  }
  renderItemIcon(refs.opponentItemIcon, refs.opponentItemNoneIcon, opponent.itemName ?? "");
  void loadImageIdMap().then((imageIds) => {
    if (currentRequestId !== requestId) return;
    renderArtwork(refs.selfArtwork, selfSelected ? selfName : "", selfSelected ? imageIds.get(selfName) : undefined);
    renderArtwork(refs.opponentArtwork, opponentName, imageIds.get(opponentName));
    refs.selfArtwork.setAttribute("aria-label", selfSelected ? `${selfName}をボックスから変更` : "ボックスから選択");
  }).catch(() => {
    if (currentRequestId !== requestId) return;
    renderArtwork(refs.selfArtwork, selfSelected ? selfName : "", undefined);
    renderArtwork(refs.opponentArtwork, opponentName, undefined);
    refs.selfArtwork.setAttribute("aria-label", selfSelected ? `${selfName}をボックスから変更` : "ボックスから選択");
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

function renderTable(container: HTMLElement, label: "攻" | "守", rows: DamageRow[]): void {
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
  container.replaceChildren(wrap);
}

function renderSpeed(container: HTMLElement, selfSpeed: number | null, opponentSpeeds: number[]): void {
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
  container.replaceChildren(root);
}

/** ダメージ割合は整数表示にする(共有の`formatDamageRange`は小数第1位まで出すため、
 * このカードでは使わずここで四捨五入して独自にフォーマットする)。 */
function percentageOnly(damages: number[], hp: number): string {
  if (!hp || hp <= 0 || damages.length === 0) return "-";
  const min = Math.round((Math.min(...damages) / hp) * 100);
  const max = Math.round((Math.max(...damages) / hp) * 100);
  return min === max ? `${min}%` : `${min}〜${max}%`;
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
  const selfBuilds = getSelfBuilds();
  const currentOpponent = getOpponentBuild();
  const opponent: OpponentBuild = { ...currentOpponent, speciesName: currentOpponent.speciesName || getDefaultOpponentName() };
  // 相手側は全カード共通なので、相手に依存する取得・計算(技の使用率・すばやさ3水準)は
  // このrun()呼び出しにつき1回だけ行い、カードの枚数ぶん繰り返さない。
  const cards: Card[] = selfBuilds.map((build, index) => ({ build, ...createCard(index) }));
  for (const card of cards) {
    renderIdentity(card.refs, card.build, opponent, currentRequestId);
    renderSpeed(card.refs.speed, null, []);
    renderTable(card.refs.attackTable, "攻", []);
    renderTable(card.refs.defenseTable, "守", []);
  }
  // 計算が終わるまで待たず、まずローディング状態のカードN枚を一括で差し込む
  // (1枚だった頃と同じ「即座にカードが差し込まれる」体験を保つ。計算中である旨のテキストは出さない)。
  byId<HTMLElement>("damage-calc-summary-list").replaceChildren(...cards.map((card) => card.root));
  try {
    const [moveDetails, usageOptions, abilityOptions] = await Promise.all([
      loadMoveDetailMap(),
      fetchOpponentMoveOptions(opponent.speciesName),
      fetchOpponentAbilityOptions(opponent.speciesName),
    ]);
    if (currentRequestId !== requestId) return;
    const abilityNames = abilityOptions.map((option) => option.value);
    const abilityName = abilityNames.includes(opponent.abilityName) ? opponent.abilityName : (abilityNames[0] ?? "");
    const opponentWithAbility = { ...opponent, abilityName };
    if (getOpponentBuild().speciesName === opponent.speciesName && getOpponentBuild().abilityName !== abilityName) {
      setOpponentBuild({ ...getOpponentBuild(), abilityName });
    }
    for (const card of cards) renderOpponentAbility(card.refs, abilityOptions, abilityName);
    const categoryOf = (moveName: string): MoveCategory => moveDetails.get(moveName)?.category ?? "status";
    const isAttackMove = (moveName: string): boolean => categoryOf(moveName) !== "status";
    const opponentMoveNames = pickOpponentDefenseMoves(usageOptions, isAttackMove);
    registerOfflineCache();
    await initEngine();
    if (currentRequestId !== requestId) return;
    const speedSpecs = opponentPatterns(opponentWithAbility, [], "spe");
    const opponentSpeeds: number[] = [];
    for (const spec of speedSpecs) opponentSpeeds.push((await calcStats(spec)).stats.spe);
    await Promise.all(cards.map(async (card) => {
      const selfMoveNames = card.build.move_names.map((name) => name.trim()).filter(Boolean).slice(0, 4).filter(isAttackMove);
      const self = isSelectedSelf(card.build) ? selfSpec(card.build) : null;
      const selfSpeed = self ? (await calcStats(self)).stats.spe : null;
      const displayedSelfSpeed = selfSpeed != null ? applySpeedItemModifier(selfSpeed, card.build.item_name) : null;
      if (currentRequestId !== requestId) return;
      renderSpeed(card.refs.speed, displayedSelfSpeed, opponentSpeeds);
      const categories = new Map<string, MoveCategory>([...selfMoveNames, ...opponentMoveNames].map((name) => [name, categoryOf(name)]));
      const attackRows = self ? await calculateAttackRows(self, opponentWithAbility, selfMoveNames, categories) : [];
      const defenseRows = self ? await calculateDefenseRows(self, opponentWithAbility, opponentMoveNames, categories) : opponentMoveNames.map((moveName) => ({ moveName, cells: PATTERN_LABELS.map(() => ({ range: "-", lethal: "" })) }));
      if (currentRequestId !== requestId) return;
      renderTable(card.refs.attackTable, "攻", attackRows);
      renderTable(card.refs.defenseTable, "守", defenseRows);
      setStatus(card.refs.status, null);
    }));
  } catch (error) {
    console.error(error);
    if (currentRequestId !== requestId) return;
    for (const card of cards) setStatus(card.refs.status, "ダメージを計算できませんでした。再度お試しください。", true);
  }
}

export function initMatchupCardList(): void {
  document.addEventListener(CHANGE_EVENT, () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(), 700);
  });
  void run();
}
