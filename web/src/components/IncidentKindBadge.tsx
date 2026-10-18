import { INCIDENT_KINDS, type IncidentKindId } from "../../../src/incidentKinds";
import { Badge } from "./ui/Badge";

/**
 * Marks an incident that is not a plain log incident (src/incidentKinds.ts, #435): opened from Cloud Monitoring alone
 * (#19), a high-cardinality overflow (#303), or a project-wide Cloud Run quota rejection. Shown wherever the incident
 * is, with the kind's own words, so none of them reads as an ordinary error of the function it names.
 */
export function IncidentKindBadge({ kind }: { kind: IncidentKindId | undefined }) {
  const label = kind === undefined ? undefined : INCIDENT_KINDS[kind].label;
  if (!label) return null;
  return (
    <span title={label.title}>
      <Badge tone="warning">{label.badge}</Badge>
    </span>
  );
}
