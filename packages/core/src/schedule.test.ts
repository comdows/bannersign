import { describe, expect, it } from "vitest";
import {
  findDuplicateTargetPeriodStarts,
  NEAR_OPEN_MS,
  normalizeTargetKey,
  planRuleWindow,
  planScheduleReconcile,
  scheduleChangedFields,
  type ExistingWindowRow,
  type ObservedWindow,
} from "./schedule.js";

const TPS = "2026-08-01T00:00:00+09:00"; // target_period_start (논리 키)

/** 기준 일정 값 (같은 논리 키) */
function values() {
  return {
    opensAt: "2026-07-01T00:00:00+09:00",
    closesAt: "2026-07-05T23:59:00+09:00",
    targetPeriodEnd: "2026-08-31T23:59:00+09:00",
    selectionMethod: "lottery" as const,
    resultExpectedAt: null,
  };
}

function existing(source: "rule" | "crawled" | "manual"): ExistingWindowRow {
  return { id: "w1", source, targetPeriodStart: TPS, ...values() };
}

function observed(overrides: Partial<ReturnType<typeof values>> = {}): ObservedWindow {
  return { targetPeriodStart: TPS, ...values(), ...overrides };
}

// 오픈까지 여유가 충분한 now (오픈 10일 전)
const FAR_NOW = Date.parse("2026-06-21T00:00:00+09:00");
// 오픈 임박 now (오픈 12시간 전)
const NEAR_NOW = Date.parse("2026-06-30T12:00:00+09:00");
const OBS_AT = "2026-06-21T09:00:00+09:00";

describe("scheduleChangedFields", () => {
  it("완전히 같으면 빈 배열", () => {
    expect(scheduleChangedFields(values(), values())).toEqual([]);
  });
  it("표기만 다른 같은 순간은 변경으로 보지 않는다(+09:00 vs Z)", () => {
    const a = values();
    const b = { ...values(), opensAt: "2026-06-30T15:00:00Z" }; // == 07-01 00:00 +09:00
    expect(scheduleChangedFields(a, b)).toEqual([]);
  });
  it("값이 다르면 해당 필드를 보고한다", () => {
    expect(scheduleChangedFields(values(), { ...values(), closesAt: "2026-07-06T23:59:00+09:00" })).toEqual([
      "closesAt",
    ]);
  });
});

describe("findDuplicateTargetPeriodStarts — 응답 내 논리 키 중복 감지", () => {
  it("중복 없으면 빈 배열", () => {
    expect(
      findDuplicateTargetPeriodStarts([
        { targetPeriodStart: "2026-08-01T00:00:00+09:00" },
        { targetPeriodStart: "2026-09-01T00:00:00+09:00" },
      ]),
    ).toEqual([]);
  });

  it("빈 입력은 빈 배열", () => {
    expect(findDuplicateTargetPeriodStarts([])).toEqual([]);
  });

  it("같은 날짜에 시각만 다른 두 관측은 중복(정규화 YYYY-MM-DD)으로 감지", () => {
    expect(
      findDuplicateTargetPeriodStarts([
        { targetPeriodStart: "2026-08-01T00:00:00+09:00" },
        { targetPeriodStart: "2026-08-01T12:00:00+09:00" },
      ]),
    ).toEqual(["2026-08-01"]);
  });

  it("중복 키는 한 번만 보고한다(3회 등장해도 1건)", () => {
    expect(
      findDuplicateTargetPeriodStarts([
        { targetPeriodStart: "2026-08-01T00:00:00+09:00" },
        { targetPeriodStart: "2026-08-01T00:00:00+09:00" },
        { targetPeriodStart: "2026-08-01T00:00:00+09:00" },
      ]),
    ).toEqual(["2026-08-01"]);
  });

  it("경계: 인접 날짜(08-31 vs 09-01)는 중복 아님", () => {
    expect(
      findDuplicateTargetPeriodStarts([
        { targetPeriodStart: "2026-08-31T00:00:00+09:00" },
        { targetPeriodStart: "2026-09-01T00:00:00+09:00" },
      ]),
    ).toEqual([]);
  });

  it("normalizeTargetKey 는 앞 10자(YYYY-MM-DD)만 취한다", () => {
    expect(normalizeTargetKey("2026-08-01T23:59:59+09:00")).toBe("2026-08-01");
  });
});

describe("planRuleWindow — 규칙 창구 생성", () => {
  it("기존 없음 → insert", () => {
    expect(planRuleWindow(null)).toBe("insert");
  });
  it("기존 rule → update_rule", () => {
    expect(planRuleWindow({ source: "rule" })).toBe("update_rule");
  });
  it("기존 crawled → skip (덮지 않음)", () => {
    expect(planRuleWindow({ source: "crawled" })).toBe("skip");
  });
  it("기존 manual → skip", () => {
    expect(planRuleWindow({ source: "manual" })).toBe("skip");
  });
});

describe("planScheduleReconcile — 기본 경로", () => {
  it("기존 없음 → insert", () => {
    expect(planScheduleReconcile(null, observed(), { nowMs: FAR_NOW, jobsExist: false, observedAt: OBS_AT }).action).toBe(
      "insert",
    );
  });

  it("동일 관측 + 기존 crawled → noop (변경 기록 없음)", () => {
    const plan = planScheduleReconcile(existing("crawled"), observed(), { nowMs: FAR_NOW, jobsExist: false, observedAt: OBS_AT });
    expect(plan.action).toBe("noop");
    expect(plan.diff).toBeUndefined();
  });

  it("동일 관측 + 기존 rule → confirm_source (rule→crawled 안전 승격)", () => {
    const plan = planScheduleReconcile(existing("rule"), observed(), { nowMs: FAR_NOW, jobsExist: false, observedAt: OBS_AT });
    expect(plan.action).toBe("confirm_source");
  });

  it("manual 은 값이 달라도 절대 건드리지 않는다 → skip_manual", () => {
    const plan = planScheduleReconcile(existing("manual"), observed({ closesAt: "2026-07-07T23:59:00+09:00" }), {
      nowMs: FAR_NOW,
      jobsExist: true,
      observedAt: OBS_AT,
    });
    expect(plan.action).toBe("skip_manual");
    expect(plan.diff).toBeUndefined();
  });
});

describe("planScheduleReconcile — 안전 변경 적용", () => {
  it("24시간 초과 + job 없음 + 값 변경 → apply(diff.applied)", () => {
    const plan = planScheduleReconcile(existing("rule"), observed({ closesAt: "2026-07-06T23:59:00+09:00" }), {
      nowMs: FAR_NOW,
      jobsExist: false,
      observedAt: OBS_AT,
    });
    expect(plan.action).toBe("apply");
    expect(plan.diff?.applied).toBe(true);
    expect(plan.diff?.changedFields).toEqual(["closesAt"]);
    expect(plan.diff?.previous.closesAt).toBe("2026-07-05T23:59:00+09:00");
    expect(plan.diff?.observed.closesAt).toBe("2026-07-06T23:59:00+09:00");
    expect(plan.diff?.observedAt).toBe(OBS_AT);
  });
});

describe("planScheduleReconcile — 위험 변경(자동 반영 금지)", () => {
  it("오픈 24시간 이내 변경 → manual_review(reason=near_open)", () => {
    const plan = planScheduleReconcile(existing("rule"), observed({ opensAt: "2026-07-02T00:00:00+09:00" }), {
      nowMs: NEAR_NOW,
      jobsExist: false,
      observedAt: OBS_AT,
    });
    expect(plan.action).toBe("manual_review");
    expect(plan.diff?.requiresManualReview).toBe(true);
    expect(plan.diff?.reason).toBe("near_open");
    expect(plan.diff?.changedFields).toContain("opensAt");
  });

  it("submission_job 존재 시 변경 → manual_review(reason=jobs_exist), 오픈 멀어도", () => {
    const plan = planScheduleReconcile(existing("crawled"), observed({ closesAt: "2026-07-08T23:59:00+09:00" }), {
      nowMs: FAR_NOW,
      jobsExist: true,
      observedAt: OBS_AT,
    });
    expect(plan.action).toBe("manual_review");
    expect(plan.diff?.reason).toBe("jobs_exist");
  });

  it("job 존재 + 오픈 임박 둘 다면 reason=jobs_exist 우선", () => {
    const plan = planScheduleReconcile(existing("rule"), observed({ opensAt: "2026-07-02T00:00:00+09:00" }), {
      nowMs: NEAR_NOW,
      jobsExist: true,
      observedAt: OBS_AT,
    });
    expect(plan.diff?.reason).toBe("jobs_exist");
  });
});

describe("planScheduleReconcile — 24시간 경계", () => {
  const openMs = Date.parse(values().opensAt);
  it("정확히 24시간 전이면 near_open(<=)로 manual_review", () => {
    const plan = planScheduleReconcile(existing("rule"), observed({ closesAt: "2026-07-06T23:59:00+09:00" }), {
      nowMs: openMs - NEAR_OPEN_MS,
      jobsExist: false,
      observedAt: OBS_AT,
    });
    expect(plan.action).toBe("manual_review");
    expect(plan.diff?.reason).toBe("near_open");
  });
  it("24시간 + 1ms 전이면 안전 변경 apply", () => {
    const plan = planScheduleReconcile(existing("rule"), observed({ closesAt: "2026-07-06T23:59:00+09:00" }), {
      nowMs: openMs - NEAR_OPEN_MS - 1,
      jobsExist: false,
      observedAt: OBS_AT,
    });
    expect(plan.action).toBe("apply");
  });
});

describe("planScheduleReconcile — 멱등(동일 재수집)", () => {
  it("같은 관측을 두 번 reconcile 해도 두 번째는 값 변화 없음(noop)", () => {
    const first = planScheduleReconcile(existing("crawled"), observed(), { nowMs: FAR_NOW, jobsExist: false, observedAt: OBS_AT });
    expect(first.action).toBe("noop");
    // apply 후 상태를 흉내: 기존이 관측값과 동일한 crawled 로 갱신됐다고 가정
    const second = planScheduleReconcile(existing("crawled"), observed(), { nowMs: FAR_NOW, jobsExist: false, observedAt: OBS_AT });
    expect(second.action).toBe("noop");
    expect(second.diff).toBeUndefined();
  });
});
