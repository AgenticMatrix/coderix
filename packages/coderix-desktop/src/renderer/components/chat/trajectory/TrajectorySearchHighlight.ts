const FIND_HIGHLIGHT = 'coderix-trajectory-find';
const FIND_ACTIVE = 'coderix-trajectory-find-active';

let stylesInjected = false;

function ensureHighlightStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = [
    `::highlight(${FIND_HIGHLIGHT}) { background-color: var(--color-find-highlight, #fde68a); }`,
    `::highlight(${FIND_ACTIVE}) { background-color: var(--color-find-highlight-active, #facc15); }`,
  ].join('\n');
  document.head.appendChild(style);
}

interface HighlightRegistryLike {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

function highlights(): HighlightRegistryLike | null {
  const registry = (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights;
  return registry ?? null;
}

/**
 * Collect all match ranges inside the scroll container, in document order,
 * restricted to `[data-trajectory-search-field]` subtrees so chrome/labels are
 * not matched. Case-insensitive substring match over raw text nodes.
 */
export function collectMatchRanges(root: HTMLElement, query: string): Range[] {
  const q = query.trim();
  if (!q) return [];
  const lower = q.toLowerCase();
  const ranges: Range[] = [];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue ?? '';
    if (!text) continue;
    if (!isInsideSearchField(node, root)) continue;

    const lowerText = text.toLowerCase();
    let idx = lowerText.indexOf(lower);
    while (idx !== -1) {
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + lower.length);
      ranges.push(range);
      idx = lowerText.indexOf(lower, idx + lower.length);
    }
  }
  return ranges;
}

function isInsideSearchField(node: Node, root: HTMLElement): boolean {
  let parent: Node | null = node.parentNode;
  while (parent && parent !== root) {
    if (parent instanceof HTMLElement && parent.hasAttribute('data-trajectory-search-field')) {
      return true;
    }
    parent = parent.parentNode;
  }
  return false;
}

/** Apply collected ranges to the CSS Custom Highlight API. */
export function applyHighlights(ranges: Range[], activeIndex: number): void {
  const registry = highlights();
  if (!registry) return;
  ensureHighlightStyles();
  try {
    const HighlightCtor = (
      window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }
    ).Highlight;
    if (!HighlightCtor) return;

    registry.set(FIND_HIGHLIGHT, new HighlightCtor(...ranges));
    const active = ranges[activeIndex];
    if (active) {
      registry.set(FIND_ACTIVE, new HighlightCtor(active));
    } else {
      registry.delete(FIND_ACTIVE);
    }
  } catch {
    // Highlight API unavailable — degrade silently (navigation still works).
  }
}

export function clearHighlights(): void {
  const registry = highlights();
  if (!registry) return;
  try {
    registry.delete(FIND_HIGHLIGHT);
    registry.delete(FIND_ACTIVE);
  } catch {
    // no-op
  }
}

/** Center the given range within the scroll container. */
export function scrollRangeIntoView(range: Range, container: HTMLElement): void {
  const rect = range.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const delta = rect.top - containerRect.top - containerRect.height / 2;
  container.scrollTop += delta;
}
