import { describe, expect, it } from "vitest";
import { cronIntervalMinutes } from "./cadence.js";

describe("cronIntervalMinutes", () => {
  it.each([
    ["* * * * *", 1],
    ["*/5 * * * *", 5],
    ["0 * * * *", 60],
    ["30 * * * *", 60],
    ["15 */6 * * *", 360],
    ["0 3 * * *", 1440],
    ["  */15   *  * * * ", 15],
  ])("reads %s as every %i minutes", (cron, minutes) => {
    expect(cronIntervalMinutes(cron)).toBe(minutes);
  });

  it.each([
    [undefined],
    [""],
    ["*/7 * * * *"], // :56 then :00: not a fixed gap
    ["0 */5 * * *"],
    ["0,30 * * * *"],
    ["0 * * * 1-5"],
    ["0 9 1 * *"],
    ["60 * * * *"],
    ["0 24 * * *"],
    ["*/0 * * * *"],
    ["@hourly"],
    ["* * * *"],
  ])("says nothing about %s rather than guess", (cron) => {
    expect(cronIntervalMinutes(cron)).toBeNull();
  });
});
