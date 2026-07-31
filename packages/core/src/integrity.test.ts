import { describe, expect, it } from "vitest";
import { checkJobContextIntegrity, type JobContextIntegrityInput } from "./integrity.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const MUNI_HWASEONG = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MUNI_SUWON = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const REQ = "33333333-3333-3333-3333-333333333333";
const WIN = "44444444-4444-4444-4444-444444444444";
const PROFILE = "55555555-5555-5555-5555-555555555555";
const DESIGN = "66666666-6666-6666-6666-666666666666";
const CRED = "77777777-7777-7777-7777-777777777777";
const BOARD_1 = "88888888-8888-8888-8888-888888888888";
const BOARD_2 = "99999999-9999-9999-9999-999999999999";

/** 정상(테넌트 A / 화성시) 기준 입력 */
function baseInput(): JobContextIntegrityInput {
  return {
    job: { tenant_id: TENANT_A, request_id: REQ, window_id: WIN },
    request: {
      id: REQ,
      tenant_id: TENANT_A,
      municipality_id: MUNI_HWASEONG,
      profile_id: PROFILE,
      design_id: DESIGN,
      credential_id: CRED,
    },
    profile: { id: PROFILE, tenant_id: TENANT_A },
    design: { id: DESIGN, tenant_id: TENANT_A },
    credential: { id: CRED, tenant_id: TENANT_A, municipality_id: MUNI_HWASEONG },
    window: { id: WIN, municipality_id: MUNI_HWASEONG },
    boardPrefIds: [BOARD_1, BOARD_2],
    boards: [
      { id: BOARD_1, municipality_id: MUNI_HWASEONG },
      { id: BOARD_2, municipality_id: MUNI_HWASEONG },
    ],
  };
}

describe("checkJobContextIntegrity — 정상 케이스", () => {
  it("모든 참조가 같은 테넌트·지자체면 통과한다", () => {
    expect(checkJobContextIntegrity(baseInput())).toEqual({ ok: true });
  });

  it("credential 이 null 이고 결합 계정도 없으면 통과한다 (nullable 허용)", () => {
    const input = baseInput();
    input.request.credential_id = null;
    input.credential = null;
    expect(checkJobContextIntegrity(input)).toEqual({ ok: true });
  });

  it("board_preferences 가 비어 있어도 통과한다", () => {
    const input = baseInput();
    input.boardPrefIds = [];
    input.boards = [];
    expect(checkJobContextIntegrity(input)).toEqual({ ok: true });
  });
});

describe("checkJobContextIntegrity — 교차 테넌트 위조", () => {
  it("사용자 B 프로필을 끼운 요청은 거부한다", () => {
    const input = baseInput();
    input.profile = { id: PROFILE, tenant_id: TENANT_B };
    const r = checkJobContextIntegrity(input);
    expect(r.ok).toBe(false);
  });

  it("사용자 B 시안을 끼운 요청은 거부한다", () => {
    const input = baseInput();
    input.design = { id: DESIGN, tenant_id: TENANT_B };
    expect(checkJobContextIntegrity(input).ok).toBe(false);
  });

  it("사용자 B 계정을 끼운 요청은 거부한다", () => {
    const input = baseInput();
    input.credential = { id: CRED, tenant_id: TENANT_B, municipality_id: MUNI_HWASEONG };
    expect(checkJobContextIntegrity(input).ok).toBe(false);
  });

  it("잡 테넌트와 요청 테넌트가 다르면 거부한다", () => {
    const input = baseInput();
    input.job.tenant_id = TENANT_B;
    expect(checkJobContextIntegrity(input).ok).toBe(false);
  });
});

describe("checkJobContextIntegrity — 교차 지자체 위조", () => {
  it("다른 지자체 계정 결합은 거부한다", () => {
    const input = baseInput();
    input.credential = { id: CRED, tenant_id: TENANT_A, municipality_id: MUNI_SUWON };
    expect(checkJobContextIntegrity(input).ok).toBe(false);
  });

  it("다른 지자체 window 결합은 거부한다", () => {
    const input = baseInput();
    input.window = { id: WIN, municipality_id: MUNI_SUWON };
    expect(checkJobContextIntegrity(input).ok).toBe(false);
  });

  it("다른 지자체 게시대(board)가 섞이면 거부한다", () => {
    const input = baseInput();
    input.boards = [
      { id: BOARD_1, municipality_id: MUNI_HWASEONG },
      { id: BOARD_2, municipality_id: MUNI_SUWON },
    ];
    expect(checkJobContextIntegrity(input).ok).toBe(false);
  });

  it("존재하지 않는 게시대가 참조되면 거부한다", () => {
    const input = baseInput();
    input.boards = [{ id: BOARD_1, municipality_id: MUNI_HWASEONG }]; // BOARD_2 누락
    expect(checkJobContextIntegrity(input).ok).toBe(false);
  });
});

describe("checkJobContextIntegrity — 결측/불일치 방어", () => {
  it("credential_id 는 있는데 계정 행이 없으면 거부한다", () => {
    const input = baseInput();
    input.credential = null; // credential_id 는 여전히 CRED
    expect(checkJobContextIntegrity(input).ok).toBe(false);
  });

  it("credential_id 가 null 인데 계정이 결합돼 있으면 거부한다", () => {
    const input = baseInput();
    input.request.credential_id = null;
    // credential 은 baseInput 의 값이 남아 있음
    expect(checkJobContextIntegrity(input).ok).toBe(false);
  });

  it("결합된 계정 ID 가 요청 credential_id 와 다르면 거부한다", () => {
    const input = baseInput();
    input.credential = { id: BOARD_1, tenant_id: TENANT_A, municipality_id: MUNI_HWASEONG };
    expect(checkJobContextIntegrity(input).ok).toBe(false);
  });
});
