import type { KeyboardEvent } from "react";

/** The focusable elements inside a dialog, in order, for keeping Tab inside it. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

/**
 * Keeps Tab and Shift+Tab inside a modal dialog: past its last control focus wraps to the first, and back from the
 * first (or from something the list does not hold, such as the panel itself or a focused heading) to the last.
 */
export function keepTabInside(e: KeyboardEvent, root: HTMLElement | null): void {
  if (e.key !== "Tab" || !root) return;
  const items = focusables(root);
  if (items.length === 0) return;
  const first = items[0];
  const end = items[items.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey && (active === first || !active || !items.includes(active))) {
    e.preventDefault();
    end.focus();
  } else if (!e.shiftKey && active === end) {
    e.preventDefault();
    first.focus();
  }
}
