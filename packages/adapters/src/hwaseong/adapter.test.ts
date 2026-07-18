import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseBoardList, parseResults } from "./parsers.js";

const fixture = (name: string) =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");

describe("hwaseong parsers (fixture regression)", () => {
  it("parses board list", () => {
    const boards = parseBoardList(fixture("boards.html"));
    expect(boards).toHaveLength(3);
    expect(boards[0]).toMatchObject({
      externalId: "HS-001",
      name: "동탄역 사거리",
      slotCount: 6,
      fee: 33000,
    });
  });

  it("parses results with outcome mapping", () => {
    const rows = parseResults(fixture("results.html"));
    expect(rows).toHaveLength(3);
    expect(rows[0]!.outcome).toBe("selected");
    expect(rows[1]!.outcome).toBe("rejected");
    expect(rows[0]!.receiptNo).toBe("2026-08-0012");
  });
});
