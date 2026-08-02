import { describe, expect, it } from "vitest";
import { TERMINAL_STATUSES, canTransition } from "./stateMachine.js";

describe("stateMachine — dry-run completion", () => {
  it("running 에서 dry_run_completed 로만 정상 완료 전이한다", () => {
    expect(canTransition("running", "dry_run_completed")).toBe(true);
    expect(canTransition("pending", "dry_run_completed")).toBe(false);
    expect(canTransition("queued", "dry_run_completed")).toBe(false);
  });

  it("dry_run_completed 는 terminal 이며 재진입할 수 없다", () => {
    expect(TERMINAL_STATUSES).toContain("dry_run_completed");
    expect(canTransition("dry_run_completed", "running")).toBe(false);
    expect(canTransition("dry_run_completed", "queued")).toBe(false);
    expect(canTransition("dry_run_completed", "submitted")).toBe(false);
  });
});
