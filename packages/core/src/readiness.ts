/**
 * 자동 신청 준비도(readiness) 판정 — 순수 함수 (S02).
 *
 * UI(RequestForm)·web server action·worker scheduler 가 "무엇이 준비됐고 무엇이
 * 부족한가" 를 동일 기준으로 판정하기 위한 단일 소스. DB(0003 트리거/RPC)가
 * 최종 권위 게이트이며, 이 순수 함수는 같은 규칙을 코드 계층에서 재사용/설명한다.
 *
 * 반환은 안정적인 issue code + 한국어 설명 + 해결 경로(링크) 또는 대기 안내.
 * DB 를 직접 만지지 않으므로 단위 테스트가 쉽다. 호출자는 DB 에서 읽은 스냅샷을
 * ReadinessInput 형태로 정규화해 넘긴다.
 */

export type ReadinessIssueCode =
  | "municipality_inactive" // status !== 'active'
  | "autosubmit_unavailable" // capabilities.autoSubmit !== true
  | "credential_missing" // credential 미등록
  | "credential_mismatch" // credential tenant/municipality 불일치 (S01 위반 잔재)
  | "credential_unusable" // status invalid/locked
  | "profile_incomplete" // business_name/phone 공백
  | "spec_missing" // 최신 municipality_specs 없음
  | "validation_missing" // 최신 spec 버전 design_validation 없음
  | "validation_failed" // 최신 검증 verdict === 'fail'
  | "boards_missing" // 선택 board 0개
  | "board_invalid"; // 존재하지 않음/타 지자체/비활성 board 포함

export interface ReadinessIssue {
  code: ReadinessIssueCode;
  /** 사용자에게 보여줄 한국어 설명 */
  messageKo: string;
  /** 사용자가 직접 해결하러 갈 링크 (있으면) */
  resolution?: { label: string; href: string };
  /** 링크로 해결 불가한 항목(운영자/시간 대기)의 안내 (있으면) */
  waitKo?: string;
}

export interface ReadinessResult {
  ready: boolean;
  issues: ReadinessIssue[];
}

/** live 제출은 active 지자체만, dry_run 리허설은 active 또는 beta 지자체를 허용한다. */
export type ReadinessMode = "live" | "dry_run";

/** 판정 대상 스냅샷 — 모든 필드는 호출자가 DB 에서 읽어 정규화해 채운다. */
export interface ReadinessInput {
  tenantId: string;
  municipalityId: string;
  /** municipalities 행 (없으면 null) */
  municipality: { status: string; capabilities: { autoSubmit: boolean } } | null;
  /** application_requests.credential_id 값 (null 이면 미선택) */
  credentialId: string | null;
  /** credential_id 로 조회한 site_credentials 행 (없으면 null) */
  credential: { tenant_id: string; municipality_id: string; status: string } | null;
  /** advertiser_profiles 행 (없으면 null) */
  profile: { business_name: string; phone: string } | null;
  /** 해당 지자체 최신 municipality_specs.version (없으면 null) */
  latestSpecVersion: number | null;
  /**
   * 선택 design × 해당 지자체의 최신(=가장 높은 version) design_validation (없으면 null).
   * specVersion 은 그 검증이 어떤 spec 버전으로 수행됐는지 — latestSpecVersion 과
   * 다르면(규격이 갱신됐는데 재검증 안 됨) 최신 검증이 없는 것으로 본다.
   */
  designValidation: { verdict: "pass" | "warn" | "fail"; specVersion: number } | null;
  /** 선택된 board id 목록 (요청 board_preferences 의 boardSiteId) */
  selectedBoardIds: string[];
  /** selectedBoardIds 로 조회한 board_sites 행 */
  boards: { id: string; municipality_id: string; is_active: boolean }[];
}

const SETTINGS = { label: "설정에서 등록", href: "/settings" };
const DESIGNS = { label: "시안 검증하기", href: "/designs" };

/**
 * 자동(active) 신청이 준비됐는지 판정. issues 가 비면 ready=true.
 * 순서는 안정적이다(항목 순).
 */
export function checkRequestReadiness(
  input: ReadinessInput,
  mode: ReadinessMode = "live",
): ReadinessResult {
  const issues: ReadinessIssue[] = [];

  // 1. live 는 active 만, dry-run 은 active/beta 만 허용. broken/disabled 는 항상 차단.
  const municipalityStatusAllowed =
    input.municipality?.status === "active" ||
    (mode === "dry_run" && input.municipality?.status === "beta");
  if (!municipalityStatusAllowed) {
    const status = input.municipality?.status ?? "unknown";
    issues.push({
      code: "municipality_inactive",
      messageKo:
        mode === "dry_run"
          ? `해당 지자체는 리허설 대상이 아닙니다 (상태: ${status}).`
          : `해당 지자체는 아직 자동 신청 대상이 아닙니다 (상태: ${status}). 지금은 수동(assisted) 신청만 안내됩니다.`,
      waitKo:
        mode === "dry_run"
          ? "지자체가 beta 또는 active 상태가 되면 리허설을 등록할 수 있습니다."
          : "지자체 자동화가 활성화되면 자동 신청을 등록할 수 있습니다.",
    });
  } else if (input.municipality?.capabilities?.autoSubmit !== true) {
    issues.push({
      code: "autosubmit_unavailable",
      messageKo: "해당 지자체는 온라인 자동 제출을 지원하지 않아 수동(assisted) 신청만 안내됩니다.",
      waitKo: "자동 제출이 지원되면 자동 신청을 등록할 수 있습니다.",
    });
  }

  // 2. 사이트 계정
  if (input.credentialId === null || input.credential === null) {
    issues.push({
      code: "credential_missing",
      messageKo: "자동 제출에는 해당 지자체 사이트 계정이 필요합니다.",
      resolution: { label: "사이트 계정 등록", href: "/settings" },
    });
  } else {
    if (
      input.credential.tenant_id !== input.tenantId ||
      input.credential.municipality_id !== input.municipalityId
    ) {
      issues.push({
        code: "credential_mismatch",
        messageKo: "선택한 사이트 계정이 이 조직·지자체 조합에 속하지 않습니다.",
        resolution: { label: "사이트 계정 확인", href: "/settings" },
      });
    } else if (input.credential.status === "invalid" || input.credential.status === "locked") {
      issues.push({
        code: "credential_unusable",
        messageKo: `사이트 계정 상태가 '${input.credential.status}' 입니다. 재확인이 필요합니다.`,
        resolution: { label: "사이트 계정 재확인", href: "/settings" },
      });
    }
  }

  // 3. 사업자 프로필 필수값
  if (
    !input.profile ||
    input.profile.business_name.trim() === "" ||
    input.profile.phone.trim() === ""
  ) {
    issues.push({
      code: "profile_incomplete",
      messageKo: "사업자 프로필의 상호명·연락처가 비어 있습니다.",
      resolution: SETTINGS,
    });
  }

  // 4. 최신 규격(spec)
  if (input.latestSpecVersion === null) {
    issues.push({
      code: "spec_missing",
      messageKo: "지자체 규격 정보가 아직 수집되지 않았습니다.",
      waitKo: "규격 수집이 완료되면 시안 검증 후 자동 신청을 등록할 수 있습니다.",
    });
  } else {
    // 5. 최신 버전 검증 존재 + fail 아님 (spec 이 있을 때만 의미 있음)
    if (
      !input.designValidation ||
      input.designValidation.specVersion !== input.latestSpecVersion
    ) {
      issues.push({
        code: "validation_missing",
        messageKo: "선택한 시안의 최신 규격 검증 결과가 없습니다 (규격이 갱신됐다면 재검증하세요).",
        resolution: DESIGNS,
      });
    } else if (input.designValidation.verdict === "fail") {
      issues.push({
        code: "validation_failed",
        messageKo: "선택한 시안이 규격 검증에서 부적합(fail) 판정을 받았습니다.",
        resolution: DESIGNS,
      });
    }
  }

  // 6. 게시대 선택 (1개 이상, 모두 존재·해당 지자체·활성)
  if (input.selectedBoardIds.length === 0) {
    issues.push({
      code: "boards_missing",
      messageKo: "희망 게시대를 1개 이상 선택하세요.",
    });
  } else {
    const byId = new Map(input.boards.map((b) => [b.id, b]));
    const bad = input.selectedBoardIds.some((id) => {
      const b = byId.get(id);
      return !b || b.municipality_id !== input.municipalityId || b.is_active !== true;
    });
    if (bad) {
      issues.push({
        code: "board_invalid",
        messageKo: "선택한 게시대 중 사용할 수 없는(타 지자체이거나 비활성) 항목이 있습니다.",
      });
    }
  }

  return { ready: issues.length === 0, issues };
}

/**
 * recurrence 규칙: 'once' 는 해당 window 의 첫 submission_job 이 생기면 즉시
 * request.status='expired' 로 전이한다. 'monthly' 는 active 유지.
 * (DB 0003 트리거가 원자적/멱등 전이의 권위 구현이고, scheduler 도 이 함수로
 *  동일 결정을 내려 로깅·방어 업데이트에 사용한다.)
 */
export function expiresAfterFirstJob(recurrence: string): boolean {
  return recurrence === "once";
}
