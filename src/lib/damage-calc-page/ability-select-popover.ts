type AbilityOption = { value: string; label: string };

let activePopover: HTMLElement | null = null;
let activeTrigger: HTMLButtonElement | null = null;

function closeAbilitySelectPopover(): void {
  activePopover?.remove();
  activeTrigger?.setAttribute("aria-expanded", "false");
  activePopover = null;
  activeTrigger = null;
}

export function openAbilitySelectPopover(
  trigger: HTMLButtonElement,
  options: readonly AbilityOption[],
  currentValue: string,
  onSelect: (value: string) => void,
): void {
  if (activeTrigger === trigger) {
    closeAbilitySelectPopover();
    return;
  }
  closeAbilitySelectPopover();

  const popover = document.createElement("div");
  popover.className = "damage-calc-ability-select-popover";
  popover.setAttribute("role", "listbox");
  popover.setAttribute("aria-label", "特性を選択");
  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "damage-calc-ability-select-popover__option";
    button.classList.toggle("is-active", option.value === currentValue);
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(option.value === currentValue));
    button.textContent = option.label;
    button.addEventListener("click", () => {
      onSelect(option.value);
      closeAbilitySelectPopover();
    });
    popover.append(button);
  }
  document.body.append(popover);

  const triggerRect = trigger.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const viewportGutter = 8;
  const showAbove = triggerRect.bottom + popoverRect.height + viewportGutter > window.innerHeight
    && triggerRect.top >= popoverRect.height + viewportGutter;
  const top = showAbove ? triggerRect.top - popoverRect.height - viewportGutter : triggerRect.bottom + viewportGutter;
  const left = Math.min(
    Math.max(viewportGutter, triggerRect.left + triggerRect.width / 2 - popoverRect.width / 2),
    window.innerWidth - popoverRect.width - viewportGutter,
  );
  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;
  popover.dataset.placement = showAbove ? "above" : "below";
  trigger.setAttribute("aria-expanded", "true");
  activePopover = popover;
  activeTrigger = trigger;
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (activePopover?.contains(target) || activeTrigger?.contains(target)) return;
  closeAbilitySelectPopover();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeAbilitySelectPopover();
});
