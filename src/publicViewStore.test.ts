import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("the sweep's walk over written incidents (#431)", () => {
  it("has its index declared in firestore.indexes.json: (environment, updatedAt ascending), the walk's order", () => {
    const file = JSON.parse(readFileSync(new URL("../firestore.indexes.json", import.meta.url), "utf8")) as {
      indexes: { collectionGroup: string; queryScope: string; fields: { fieldPath: string; order?: string }[] }[];
    };
    expect(file.indexes).toContainEqual({
      collectionGroup: "incidents",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "environment", order: "ASCENDING" },
        { fieldPath: "updatedAt", order: "ASCENDING" },
      ],
    });
  });
});
