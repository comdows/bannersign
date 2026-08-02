import { describe, expect, it } from "vitest";
import {
  canPrepareWindow,
  effectiveDryRun,
  failureTerminalStatus,
  municipalityRunBlock,
  windowRunTiming,
} from "./rehearsal.js";

const NOW = new Date("2026-08-02T00:00:00.000Z");

describe("effectiveDryRun", () => {
  it("is fail-safe: any true signal wins", () => {
    expect(effectiveDryRun(true, false, false, false)).toBe(true);
    expect(effectiveDryRun(false, true, false, false)).toBe(true);
    expect(effectiveDryRun(false, false, true, false)).toBe(true);
    expect(effectiveDryRun(false, false, false, true)).toBe(true);
  });

  it("is false only when every signal is absent or false", () => {
    expect(effectiveDryRun(false, false, undefined, null)).toBe(false);
  });
});

describe("canPrepareWindow", () => {
  it("prepares upcoming windows for live or rehearsal requests", () => {
    const future = "2026-08-03T00:00:00.000Z";
    expect(canPrepareWindow("upcoming", false, future, NOW)).toBe(true);
    expect(canPrepareWindow("upcoming", true, future, NOW)).toBe(true);
  });

  it("allows open-window catch-up only for guaranteed dry-runs", () => {
    const past = "2026-08-01T00:00:00.000Z";
    expect(canPrepareWindow("open", true, past, NOW)).toBe(true);
    expect(canPrepareWindow("open", false, past, NOW)).toBe(false);
    expect(canPrepareWindow("upcoming", true, past, NOW)).toBe(true);
    expect(canPrepareWindow("upcoming", false, past, NOW)).toBe(false);
  });

  it("never prepares closed or unknown windows", () => {
    expect(canPrepareWindow("closed", true, "2026-08-01T00:00:00.000Z", NOW)).toBe(false);
    expect(canPrepareWindow("results_out", true, "2026-08-01T00:00:00.000Z", NOW)).toBe(false);
    expect(canPrepareWindow("upcoming", true, "not-a-date", NOW)).toBe(false);
  });
});

describe("windowRunTiming", () => {
  it("classifies execution against actual timestamps, independent of a stale status", () => {
    expect(windowRunTiming("2026-08-03T00:00:00Z", "2026-08-04T00:00:00Z", NOW)).toBe("before");
    expect(windowRunTiming("2026-08-01T00:00:00Z", "2026-08-03T00:00:00Z", NOW)).toBe("open");
    expect(windowRunTiming("2026-07-31T00:00:00Z", "2026-08-01T00:00:00Z", NOW)).toBe("closed");
    expect(windowRunTiming("invalid", "2026-08-03T00:00:00Z", NOW)).toBe("invalid");
  });
});

describe("municipalityRunBlock", () => {
  it("allows beta only when every action is forced into dry-run mode", () => {
    expect(municipalityRunBlock("beta", true, true)).toBeNull();
    expect(municipalityRunBlock("beta", false, true)).toBe("dry_run_safety_violation");
  });

  it("blocks disabled, broken, and no-auto municipalities in every mode", () => {
    expect(municipalityRunBlock("disabled", true, true)).toBe("validation_rejected");
    expect(municipalityRunBlock("broken", true, true)).toBe("validation_rejected");
    expect(municipalityRunBlock("active", true, false)).toBe("validation_rejected");
  });
});

describe("failureTerminalStatus", () => {
  it("never treats an already-submitted response during rehearsal as this job's live submission", () => {
    expect(failureTerminalStatus("already_submitted", true, true)).toBe("needs_manual");
    expect(failureTerminalStatus("already_submitted", false, true)).toBe("needs_manual");
    expect(failureTerminalStatus("already_submitted", false, false)).toBe("submitted");
  });

  it("routes audit and safety failures to manual review", () => {
    expect(failureTerminalStatus("audit_incomplete", false, true)).toBe("needs_manual");
    expect(failureTerminalStatus("dry_run_safety_violation", false, true)).toBe("needs_manual");
  });
});
