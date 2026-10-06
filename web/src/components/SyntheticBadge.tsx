import { Badge } from "./ui/Badge";

/**
 * Marks a record written by `pnpm seed-demo` (src/seedDemo.ts): an illustration of what a run leaves behind,
 * not a run that happened. Shown wherever such a record is, so it is never mistaken for real evidence.
 */
export function SyntheticBadge() {
  return (
    <span title="Synthetic demo data: written by pnpm seed-demo to show what a run records. No agent ran this.">
      <Badge tone="info">Synthetic</Badge>
    </span>
  );
}
