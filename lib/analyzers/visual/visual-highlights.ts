/** Document-coordinate box (CSS px from the page's top-left), matching a full-page screenshot. */
export interface DocRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One on-page location of a visual defect; `kind` is the finding message it belongs to. */
export interface VisualHighlight {
  kind: string;
  rect: DocRect;
  label: string;
}

/** Highlights kept per finding kind on one page — enough to show the defect, small enough to persist. */
export const MAX_HIGHLIGHTS_PER_KIND = 6;

export function capHighlights(items: VisualHighlight[]): VisualHighlight[] {
  const perKind = new Map<string, number>();
  return items.filter((h) => {
    const n = perKind.get(h.kind) ?? 0;
    perKind.set(h.kind, n + 1);
    return n < MAX_HIGHLIGHTS_PER_KIND;
  });
}
