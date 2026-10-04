import { describe, expect, it } from "vitest";
import { pnpmInvocation } from "./verify-gate.mjs";

const NODE = "/usr/bin/node";

describe("pnpmInvocation", () => {
  it("runs pnpm's own JavaScript entry with node when started by pnpm: no .cmd, no shell, on any platform", () => {
    for (const platform of ["win32", "linux", "darwin"]) {
      expect(
        pnpmInvocation({ npm_execpath: "/home/u/.local/share/pnpm/bin/pnpm.cjs" }, platform, NODE)
      ).toEqual({ command: NODE, prefix: ["/home/u/.local/share/pnpm/bin/pnpm.cjs"], shell: false });
    }
    expect(
      pnpmInvocation({ npm_execpath: "C:\\Users\\u\\AppData\\Local\\pnpm\\pnpm.cjs" }, "win32", NODE).shell
    ).toBe(false);
  });

  it("uses the .cmd only through a shell on Windows when started directly", () => {
    expect(pnpmInvocation({}, "win32", NODE)).toEqual({ command: "pnpm.cmd", prefix: [], shell: true });
  });

  it("is the bare name with no shell elsewhere when started directly", () => {
    expect(pnpmInvocation({}, "linux", NODE)).toEqual({ command: "pnpm", prefix: [], shell: false });
    expect(pnpmInvocation({}, "darwin", NODE)).toEqual({ command: "pnpm", prefix: [], shell: false });
  });

  it("ignores an npm_execpath that is not a pnpm JavaScript entry", () => {
    // Started by npm: running its script as pnpm would be wrong.
    expect(pnpmInvocation({ npm_execpath: "/usr/lib/node_modules/npm/bin/npm-cli.js" }, "linux", NODE).command).toBe(
      "pnpm"
    );
    // A standalone pnpm binary is not JavaScript, so node must not be asked to run it.
    expect(pnpmInvocation({ npm_execpath: "/usr/local/bin/pnpm" }, "linux", NODE).command).toBe("pnpm");
    expect(pnpmInvocation({ npm_execpath: "C:\\pnpm\\pnpm.exe" }, "win32", NODE)).toEqual({
      command: "pnpm.cmd",
      prefix: [],
      shell: true,
    });
  });
});
