import { describe, expect, it } from "vitest";
import {
  checkRequestReadiness,
  expiresAfterFirstJob,
  type ReadinessInput,
  type ReadinessIssueCode,
} from "./readiness.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const MUNI = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_MUNI = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CRED = "77777777-7777-7777-7777-777777777777";
const BOARD = "88888888-8888-8888-8888-888888888888";

/** 완전히 준비된 기준 입력 */
function ready(): ReadinessInput {
  return {
    tenantId: TENANT,
    municipalityId: MUNI,
    municipality: { status: "active", capabilities: { autoSubmit: true } },
    credentialId: CRED,
    credential: { tenant_id: TENANT, municipality_id: MUNI, status: "ok" },
    profile: { business_name: "이음네트웍스", phone: "010-1234-5678" },
    latestSpecVersion: 3,
    designValidation: { verdict: "pass", specVersion: 3 },
    selectedBoardIds: [BOARD],
    boards: [{ id: BOARD, municipality_id: MUNI, is_active: true }],
  };
}

function codes(input: ReadinessInput): ReadinessIssueCode[] {
  return checkRequestReadiness(input).issues.map((i) => i.code);
}

describe("checkRequestReadiness — 정상", () => {
  it("모든 조건 충족 시 ready=true, issues 없음", () => {
    const r = checkRequestReadiness(ready());
    expect(r.ready).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it("verdict=warn 도 허용한다", () => {
    const input = ready();
    input.designValidation = { verdict: "warn", specVersion: 3 };
    expect(checkRequestReadiness(input).ready).toBe(true);
  });
});

describe("checkRequestReadiness — 지자체 상태", () => {
  it.each(["beta", "broken", "disabled", "unknown"])(
    "status=%s 는 municipality_inactive 로 자동 불가",
    (status) => {
      const input = ready();
      input.municipality = { status, capabilities: { autoSubmit: true } };
      const r = checkRequestReadiness(input);
      expect(r.ready).toBe(false);
      expect(r.issues.map((i) => i.code)).toContain("municipality_inactive");
    },
  );

  it("municipality=null 도 municipality_inactive", () => {
    const input = ready();
    input.municipality = null;
    expect(codes(input)).toContain("municipality_inactive");
  });

  it("active 이지만 autoSubmit=false 면 autosubmit_unavailable", () => {
    const input = ready();
    input.municipality = { status: "active", capabilities: { autoSubmit: false } };
    expect(codes(input)).toContain("autosubmit_unavailable");
  });

  it("municipality_inactive 이슈에는 대기 안내(waitKo)가 있다", () => {
    const input = ready();
    input.municipality = { status: "beta", capabilities: { autoSubmit: true } };
    const issue = checkRequestReadiness(input).issues.find((i) => i.code === "municipality_inactive");
    expect(issue?.waitKo).toBeTruthy();
    expect(issue?.resolution).toBeUndefined();
  });
});

describe("checkRequestReadiness — 사이트 계정", () => {
  it("credential 미선택은 credential_missing + /settings 링크", () => {
    const input = ready();
    input.credentialId = null;
    input.credential = null;
    const issue = checkRequestReadiness(input).issues.find((i) => i.code === "credential_missing");
    expect(issue?.resolution?.href).toBe("/settings");
  });

  it("credential 이 타 지자체면 credential_mismatch", () => {
    const input = ready();
    input.credential = { tenant_id: TENANT, municipality_id: OTHER_MUNI, status: "ok" };
    expect(codes(input)).toContain("credential_mismatch");
  });

  it("credential 이 타 테넌트면 credential_mismatch", () => {
    const input = ready();
    input.credential = { tenant_id: "99999999-9999-9999-9999-999999999999", municipality_id: MUNI, status: "ok" };
    expect(codes(input)).toContain("credential_mismatch");
  });

  it.each(["invalid", "locked"])("credential status=%s 는 credential_unusable", (status) => {
    const input = ready();
    input.credential = { tenant_id: TENANT, municipality_id: MUNI, status };
    expect(codes(input)).toContain("credential_unusable");
  });

  it("credential status=unverified 는 허용된다", () => {
    const input = ready();
    input.credential = { tenant_id: TENANT, municipality_id: MUNI, status: "unverified" };
    expect(checkRequestReadiness(input).ready).toBe(true);
  });
});

describe("checkRequestReadiness — 프로필", () => {
  it("business_name 공백은 profile_incomplete", () => {
    const input = ready();
    input.profile = { business_name: "   ", phone: "010-1" };
    expect(codes(input)).toContain("profile_incomplete");
  });

  it("phone 공백은 profile_incomplete", () => {
    const input = ready();
    input.profile = { business_name: "회사", phone: "" };
    expect(codes(input)).toContain("profile_incomplete");
  });

  it("profile=null 은 profile_incomplete", () => {
    const input = ready();
    input.profile = null;
    expect(codes(input)).toContain("profile_incomplete");
  });
});

describe("checkRequestReadiness — 규격/검증", () => {
  it("최신 spec 없음은 spec_missing (검증 이슈는 중복 발생 안 함)", () => {
    const input = ready();
    input.latestSpecVersion = null;
    const c = codes(input);
    expect(c).toContain("spec_missing");
    expect(c).not.toContain("validation_missing");
  });

  it("검증 없음은 validation_missing + /designs 링크", () => {
    const input = ready();
    input.designValidation = null;
    const issue = checkRequestReadiness(input).issues.find((i) => i.code === "validation_missing");
    expect(issue?.resolution?.href).toBe("/designs");
  });

  it("최신 spec 버전과 검증 버전이 다르면 validation_missing", () => {
    const input = ready();
    input.latestSpecVersion = 4;
    input.designValidation = { verdict: "pass", specVersion: 3 }; // 규격 갱신됨, 재검증 안 함
    expect(codes(input)).toContain("validation_missing");
  });

  it("verdict=fail 은 validation_failed", () => {
    const input = ready();
    input.designValidation = { verdict: "fail", specVersion: 3 };
    expect(codes(input)).toContain("validation_failed");
  });
});

describe("checkRequestReadiness — 게시대", () => {
  it("board 0개는 boards_missing", () => {
    const input = ready();
    input.selectedBoardIds = [];
    input.boards = [];
    expect(codes(input)).toContain("boards_missing");
  });

  it("비활성 board 포함은 board_invalid", () => {
    const input = ready();
    input.boards = [{ id: BOARD, municipality_id: MUNI, is_active: false }];
    expect(codes(input)).toContain("board_invalid");
  });

  it("타 지자체 board 포함은 board_invalid", () => {
    const input = ready();
    input.boards = [{ id: BOARD, municipality_id: OTHER_MUNI, is_active: true }];
    expect(codes(input)).toContain("board_invalid");
  });

  it("존재하지 않는 board 참조는 board_invalid", () => {
    const input = ready();
    input.boards = []; // 선택 id 는 있으나 조회 결과 없음
    expect(codes(input)).toContain("board_invalid");
  });
});

describe("checkRequestReadiness — 복합", () => {
  it("여러 항목이 동시에 부족하면 모두 보고한다", () => {
    const input = ready();
    input.credentialId = null;
    input.credential = null;
    input.profile = null;
    input.selectedBoardIds = [];
    input.boards = [];
    const c = codes(input);
    expect(c).toEqual(
      expect.arrayContaining(["credential_missing", "profile_incomplete", "boards_missing"]),
    );
    expect(checkRequestReadiness(input).ready).toBe(false);
  });
});

describe("expiresAfterFirstJob", () => {
  it("once 는 첫 job 후 만료", () => {
    expect(expiresAfterFirstJob("once")).toBe(true);
  });
  it("monthly 는 유지", () => {
    expect(expiresAfterFirstJob("monthly")).toBe(false);
  });
});
