import { describe, it, expect } from "vitest";
import { INCIDENT_KIND_IDS, INCIDENT_KINDS, incidentKindOf } from "./incidentKinds.js";

describe("the incident kinds table (#435)", () => {
  it("reads a record's kind from its signal source, else its fingerprint's namespace, else log", () => {
    expect(incidentKindOf({ signalSource: "overflow" }).id).toBe("overflow");
    expect(incidentKindOf({ fingerprint: "pq-0123" }).id).toBe("platform-quota");
    expect(incidentKindOf({ fingerprint: "mon-0123" }).id).toBe("monitoring");
    expect(incidentKindOf({ fingerprint: "ovf-0123" }).id).toBe("overflow");
    expect(incidentKindOf({ fingerprint: "0123456789abcdef" }).id).toBe("log");
    expect(incidentKindOf({ signalSource: "nonsense", fingerprint: 7 }).id).toBe("log");
    expect(incidentKindOf(undefined).id).toBe("log");
  });

  it("gives every kind but log its own namespace, and every prefix to one kind only", () => {
    const prefixes = INCIDENT_KIND_IDS.map((id) => INCIDENT_KINDS[id].prefix);
    expect(prefixes.filter((p) => p !== "")).toHaveLength(INCIDENT_KIND_IDS.length - 1);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const id of INCIDENT_KIND_IDS) expect(INCIDENT_KINDS[id].id).toBe(id);
  });

  it("gates the two kinds no code change fixes, and keeps class rules off exactly those", () => {
    for (const id of INCIDENT_KIND_IDS) {
      const kind = INCIDENT_KINDS[id];
      expect(kind.overridesClassRules).toBe(kind.gate !== undefined);
    }
    expect(INCIDENT_KINDS.overflow.gate?.rule).toBe("high-cardinality-overflow");
    expect(INCIDENT_KINDS["platform-quota"].gate?.rule).toBe("platform-quota");
  });

  it("labels every kind the UI must tell apart from a log incident", () => {
    expect(INCIDENT_KINDS.log.label).toBeUndefined();
    for (const id of INCIDENT_KIND_IDS.filter((k) => k !== "log")) expect(INCIDENT_KINDS[id].label?.badge).toBeTruthy();
  });
});
