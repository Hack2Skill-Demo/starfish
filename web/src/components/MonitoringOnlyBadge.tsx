import { Badge } from "./ui/Badge";

/**
 * Marks an incident opened from Cloud Monitoring alone (#19): failed invocations with no ERROR log entry, so there
 * is no message or stack trace to read and the log recount is zero by construction. Shown wherever the incident is.
 */
export function MonitoringOnlyBadge() {
  return (
    <span title="Opened from Cloud Monitoring alone: failed invocations counted with no ERROR log entry. There is no log message or stack trace.">
      <Badge tone="warning">Monitoring only</Badge>
    </span>
  );
}
