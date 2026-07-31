/**
 * 테넌트·지자체 참조 무결성 검증 (순수 함수) — S01.
 *
 * DB 계층(복합 FK + 트리거 + 보안 RPC)이 1차 방어선이지만, worker 는
 * service_role 로 RLS 를 우회해 직접 행을 읽어 외부 사이트에 제출한다.
 * 오염된 데이터가 어떤 경로로든 남아 있을 때, Playwright/브라우저/외부 사이트에
 * 접속하기 "전에" 이 순수 검증기로 한 번 더 막는다(defense in depth).
 *
 * 순수 함수라 DB 없이 단위 테스트가 가능하다. worker 의 loadJobContext 는
 * DB 에서 읽은 행을 이 함수 입력 형태로 정규화해 호출한다.
 */

export interface IntegrityJob {
  tenant_id: string;
  request_id: string;
  window_id: string;
}

export interface IntegrityRequest {
  id: string;
  tenant_id: string;
  municipality_id: string;
  profile_id: string;
  design_id: string;
  credential_id: string | null;
}

export interface IntegrityTenantOwned {
  id: string;
  tenant_id: string;
}

export interface IntegrityCredential {
  id: string;
  tenant_id: string;
  municipality_id: string;
}

export interface IntegrityMunicipalityOwned {
  id: string;
  municipality_id: string;
}

export interface JobContextIntegrityInput {
  job: IntegrityJob;
  request: IntegrityRequest;
  /** advertiser_profiles 행 (tenant 소유) */
  profile: IntegrityTenantOwned | null;
  /** designs 행 (tenant 소유) */
  design: IntegrityTenantOwned | null;
  /** site_credentials 행. request.credential_id 가 null 이면 null 이어야 정상 */
  credential: IntegrityCredential | null;
  /** application_windows 행 (지자체 소유) */
  window: IntegrityMunicipalityOwned | null;
  /** board_preferences 에 담긴 boardSiteId 목록 */
  boardPrefIds: string[];
  /** boardPrefIds 로 조회된 board_sites 행 (id, municipality_id) */
  boards: IntegrityMunicipalityOwned[];
}

export type IntegrityResult = { ok: true } | { ok: false; detail: string };

/**
 * job 컨텍스트가 테넌트·지자체 경계를 넘지 않는지 검증한다.
 * 위반 시 첫 위반 사유를 담은 { ok: false, detail } 를 반환한다.
 */
export function checkJobContextIntegrity(input: JobContextIntegrityInput): IntegrityResult {
  const { job, request, profile, design, credential, window, boardPrefIds, boards } = input;

  // 0. request ↔ job tenant 일치
  if (request.tenant_id !== job.tenant_id) {
    return {
      ok: false,
      detail: `요청 테넌트(${request.tenant_id})가 잡 테넌트(${job.tenant_id})와 다릅니다.`,
    };
  }

  // 1. profile ↔ tenant
  if (!profile) return { ok: false, detail: "광고주 프로필을 찾을 수 없습니다." };
  if (profile.tenant_id !== request.tenant_id) {
    return { ok: false, detail: "광고주 프로필이 요청 테넌트에 속하지 않습니다." };
  }

  // 2. design ↔ tenant
  if (!design) return { ok: false, detail: "시안을 찾을 수 없습니다." };
  if (design.tenant_id !== request.tenant_id) {
    return { ok: false, detail: "시안이 요청 테넌트에 속하지 않습니다." };
  }

  // 3. credential ↔ tenant + municipality (nullable)
  if (request.credential_id === null) {
    if (credential !== null) {
      return { ok: false, detail: "credential 미등록 요청에 계정이 결합되어 있습니다." };
    }
  } else {
    if (!credential) return { ok: false, detail: "사이트 계정을 찾을 수 없습니다." };
    if (credential.id !== request.credential_id) {
      return { ok: false, detail: "결합된 사이트 계정 ID가 요청과 다릅니다." };
    }
    if (credential.tenant_id !== request.tenant_id) {
      return { ok: false, detail: "사이트 계정이 요청 테넌트에 속하지 않습니다." };
    }
    if (credential.municipality_id !== request.municipality_id) {
      return { ok: false, detail: "사이트 계정이 요청 지자체에 속하지 않습니다." };
    }
  }

  // 4. window ↔ request municipality
  if (!window) return { ok: false, detail: "신청 창구(window)를 찾을 수 없습니다." };
  if (window.municipality_id !== request.municipality_id) {
    return { ok: false, detail: "신청 창구의 지자체가 요청 지자체와 다릅니다." };
  }

  // 5. board_preferences 의 모든 boardSiteId ↔ request municipality
  const boardById = new Map(boards.map((b) => [b.id, b]));
  for (const id of boardPrefIds) {
    const board = boardById.get(id);
    if (!board) {
      return { ok: false, detail: `게시대(${id})를 찾을 수 없습니다.` };
    }
    if (board.municipality_id !== request.municipality_id) {
      return { ok: false, detail: `게시대(${id})가 요청 지자체에 속하지 않습니다.` };
    }
  }

  return { ok: true };
}
