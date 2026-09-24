/**
 * Minimal imperative toasts. No provider to mount: the first call creates a
 * polite live region at the bottom-right of <body>, and each message removes
 * itself after a few seconds. Messages are set as textContent, never HTML.
 */
type Kind = "success" | "error";

const DURATION_MS = 5000;
const REGION_ID = "starfish-toasts";

const KIND_CLASSES: Record<Kind, string> = {
  success: "border-success-200 bg-success-50 text-success-800 dark:border-success-800 dark:bg-success-950 dark:text-success-200",
  error: "border-error-200 bg-error-50 text-error-800 dark:border-error-800 dark:bg-error-950 dark:text-error-200",
};

function region(): HTMLElement {
  const existing = document.getElementById(REGION_ID);
  if (existing) return existing;
  const el = document.createElement("div");
  el.id = REGION_ID;
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.className = "pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2";
  document.body.appendChild(el);
  return el;
}

function show(kind: Kind, message: string): void {
  if (typeof document === "undefined") return;
  const item = document.createElement("div");
  item.className = `pointer-events-auto rounded-lg border px-4 py-3 text-sm shadow-lg ${KIND_CLASSES[kind]}`;
  item.textContent = message;
  region().appendChild(item);
  window.setTimeout(() => item.remove(), DURATION_MS);
}

export const toast = {
  success: (message: string) => show("success", message),
  error: (message: string) => show("error", message),
};
