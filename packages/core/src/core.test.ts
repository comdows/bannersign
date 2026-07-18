import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { checkAspectRatio } from "./ratio.js";
import { assertTransition, canTransition } from "./stateMachine.js";
import type { DesignSpec, WindowRule } from "./types.js";
import { upcomingWindows, windowForMonth } from "./windows.js";

const SPEC: DesignSpec = {
  sizeCm: { width: 500, height: 70 },
  ratioTolerance: 0.03,
  fileFormats: ["jpg", "jpeg"],
};

describe("crypto", () => {
  const key = Buffer.alloc(32, 7);

  it("round-trips secrets", () => {
    const enc = encryptSecret("p@ssw0rd!한글", key);
    expect(decryptSecret(enc, key)).toBe("p@ssw0rd!한글");
  });

  it("fails on tampered ciphertext", () => {
    const enc = encryptSecret("secret", key);
    const buf = Buffer.from(enc.data, "base64");
    buf[0] = buf[0]! ^ 0xff;
    expect(() => decryptSecret({ ...enc, data: buf.toString("base64") }, key)).toThrow();
  });
});

describe("checkAspectRatio", () => {
  it("passes within tolerance", () => {
    // 500:70 = 7.142857 → 5000x700 px 정확히 일치
    expect(checkAspectRatio({ width: 5000, height: 700 }, SPEC).result).toBe("pass");
  });

  it("fails outside tolerance", () => {
    expect(checkAspectRatio({ width: 1920, height: 1080 }, SPEC).result).toBe("fail");
  });
});

describe("stateMachine", () => {
  it("allows the happy path", () => {
    expect(canTransition("pending", "queued")).toBe(true);
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "submitted")).toBe(true);
  });

  it("rejects regressions from terminal states", () => {
    expect(canTransition("submitted", "running")).toBe(false);
    expect(() => assertTransition("submitted", "queued")).toThrow();
  });

  it("supports captcha relay loop", () => {
    expect(canTransition("running", "awaiting_captcha")).toBe(true);
    expect(canTransition("awaiting_captcha", "running")).toBe(true);
  });
});

describe("windows", () => {
  const rule: WindowRule = {
    openDayOfMonth: 1,
    closeDayOfMonth: 5,
    openTime: "09:00",
    closeTime: "18:00",
    timezone: "Asia/Seoul",
    targetMonthOffset: 1,
    selectionMethod: "lottery",
    resultAfterCloseDays: 3,
  };

  it("builds a monthly window instance in KST", () => {
    const w = windowForMonth(rule, 2026, 8);
    expect(w.opensAt).toBe("2026-08-01T09:00:00+09:00");
    expect(w.closesAt).toBe("2026-08-05T18:00:00+09:00");
    expect(w.targetPeriodStart).toBe("2026-09-01T00:00:00+09:00");
    expect(w.selectionMethod).toBe("lottery");
  });

  it("skips windows that already closed", () => {
    // 2026-07-18: 7월 창구(7/5 마감)는 지났고 8월 창구만 남아야 함
    const wins = upcomingWindows(rule, new Date("2026-07-18T00:00:00Z"));
    expect(wins).toHaveLength(1);
    expect(wins[0]!.opensAt).toBe("2026-08-01T09:00:00+09:00");
  });

  it("handles year rollover on target month", () => {
    const w = windowForMonth(rule, 2026, 12);
    expect(w.targetPeriodStart).toBe("2027-01-01T00:00:00+09:00");
  });
});
