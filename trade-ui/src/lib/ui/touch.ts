export const isTouch = (): boolean => matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;

const TEXT_INPUTS = new Set(['text', 'number', 'search', 'email', 'password', 'tel', 'url', 'range', 'date', 'time']);

export const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t instanceof HTMLInputElement && TEXT_INPUTS.has(t.type)));

/** Steps through `stops` in order and wraps; from anywhere else it goes to the nearest stop after (Shift: before) the focus. */
function step(e: KeyboardEvent, stops: HTMLElement[], at: Element = document.activeElement ?? document.body) {
  const list = stops.filter((el) => !(el as HTMLInputElement).disabled && el.tabIndex >= 0 && el.getClientRects().length > 0);
  if (!list.length) return;
  e.preventDefault();
  const back = e.shiftKey;
  const i = list.indexOf(at as HTMLElement);
  const ahead = (el: HTMLElement) => !!(at.compareDocumentPosition(el) & (back ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING));
  const next = i >= 0 ? list.at((i + (back ? -1 : 1)) % list.length)! : ((back ? list.findLast(ahead) : list.find(ahead)) ?? list.at(back ? -1 : 0)!);
  next.focus();
  if (next instanceof HTMLInputElement) next.select();
}

const all = (root: Element, sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];

export function tabNavigation(e: KeyboardEvent) {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const root = e.currentTarget as HTMLElement;
  const tabs = all(root, '[role=tab]').filter(el => !(el as HTMLButtonElement).disabled);
  const current = tabs.indexOf(document.activeElement as HTMLElement);
  if (current < 0 || !tabs.length) return;
  const index = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (current + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  e.preventDefault();
  e.stopPropagation();
  tabs[index].focus();
  tabs[index].click();
}

let pressed: EventTarget[] = [];
/** Panel buttons blur themselves on click, so Tab from body starts where the last press was (its first part still on the page: a picked menu option is gone). */
export const notePress = (e: PointerEvent) => (pressed = e.composedPath());

/** Tab stays inside an open dialog (its fields, then its buttons) and, in the order panel, moves between its typed fields only. */
export function tabStops(e: KeyboardEvent) {
  if (e.key !== 'Tab' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  const dialog = document.querySelector('[role=dialog][aria-modal=true]') ?? document.querySelector('[role=dialog]');
  if (dialog) return step(e, [...all(dialog, 'input, select, textarea, a[href]'), ...all(dialog, 'button')]);
  const active = document.activeElement;
  const at = active && active !== document.body ? active : pressed.find((t): t is Element => t instanceof Element && t.isConnected);
  const panel = at?.closest('[data-testid=panel]');
  if (panel) step(e, all(panel, 'input:not([type=checkbox])'), at);
}
