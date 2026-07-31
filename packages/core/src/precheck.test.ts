import { describe, expect, it } from "vitest";
import { canStartSubmission, SUBMITTABLE_STATUSES } from "./stateMachine.js";
import {
  classifyLoginFailure,
  groupPrecheckJobsByCredential,
  isCredentialFault,
  planCredentialPrecheck,
  precheckJobId,
  PRECHECK_BUCKET_MS,
  PRECHECK_MAX_ATTEMPTS,
  PRECHECK_MESSAGES,
  PRECHECK_STALE_MS,
  redactSecrets,
  runWindowPrecheck,
  type PrecheckJobRow,
  type PrecheckLoginOutcome,
  type PrecheckNotification,
  type PrecheckPorts,
  type PrecheckRecord,
  type PrecheckRecordStatus,
} from "./precheck.js";

const WINDOW = "w-1";
const MUNI = "m-1";
const T1 = "t-1";
const T2 = "t-2";

// ===========================================================================
// 순수 함수
// ===========================================================================

describe("redactSecrets", () => {
  it("비밀 문자열을 마스킹한다", () => {
    expect(redactSecrets("login failed for hong with p@ss!", ["hong", "p@ss!"])).toBe(
      "login failed for *** with ***",
    );
  });

  it("긴 비밀을 먼저 치환해 부분 노출을 막는다", () => {
    expect(redactSecrets("pw=secret123", ["secret", "secret123"])).toBe("pw=***");
  });

  it("빈 비밀은 무시한다(전체 문자열이 깨지지 않음)", () => {
    expect(redactSecrets("abc", ["", "b"])).toBe("a***c");
  });

  it("제어문자/연속 공백을 정리하고 길이를 자른다", () => {
    const noisy = ["a", "b"].join(String.fromCharCode(0)) + "   c";
    expect(redactSecrets(noisy, [])).toBe("a b c");
    expect(redactSecrets("x".repeat(50), [], 10)).toHaveLength(11); // 10자 + 말줄임표
  });
});

describe("classifyLoginFailure", () => {
  it("login_failed 는 기본적으로 invalid (최소 보장)", () => {
    expect(classifyLoginFailure({ code: "login_failed", message: "로그인 실패 — 아이디/비밀번호 확인 필요" })).toBe(
      "invalid",
    );
  });

  it("잠금 근거가 있으면 locked 로 승격한다", () => {
    expect(classifyLoginFailure({ code: "login_failed", message: "계정이 잠금 상태입니다" })).toBe("locked");
    expect(classifyLoginFailure({ code: "login_failed", message: "Account is locked" })).toBe("locked");
    expect(classifyLoginFailure({ code: "login_failed", message: "이용정지된 계정" })).toBe("locked");
  });

  it("사이트/네트워크 오류는 계정 탓으로 돌리지 않는다", () => {
    expect(classifyLoginFailure({ code: "network", message: "timeout" })).toBe("error");
    expect(classifyLoginFailure({ code: "selector_missing", message: "no #id" })).toBe("error");
  });

  it("코드 없는 예외/비정상 값은 error", () => {
    expect(classifyLoginFailure(new Error("boom"))).toBe("error");
    expect(classifyLoginFailure(null)).toBe("error");
    expect(classifyLoginFailure("문자열 오류")).toBe("error");
  });

  it("isCredentialFault 는 invalid/locked 만 참", () => {
    expect(isCredentialFault("invalid")).toBe(true);
    expect(isCredentialFault("locked")).toBe(true);
    expect(isCredentialFault("error")).toBe(false);
    expect(isCredentialFault("ok")).toBe(false);
  });
});

function jobRow(over: Partial<PrecheckJobRow> & { jobId: string }): PrecheckJobRow {
  const credentialId = over.credential?.id ?? "c-1";
  return {
    tenantId: T1,
    status: "pending",
    requestId: `r-${over.jobId}`,
    request: {
      id: `r-${over.jobId}`,
      tenant_id: T1,
      municipality_id: MUNI,
      credential_id: credentialId,
    },
    credential: { id: credentialId, tenant_id: T1, municipality_id: MUNI, status: "ok" },
    ...over,
  };
}

describe("groupPrecheckJobsByCredential", () => {
  it("같은 계정을 공유하는 여러 잡을 한 그룹으로 묶는다", () => {
    const { groups, rejected } = groupPrecheckJobsByCredential(
      [jobRow({ jobId: "j1" }), jobRow({ jobId: "j2" }), jobRow({ jobId: "j3" })],
      { municipalityId: MUNI },
    );
    expect(rejected).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.jobs.map((j) => j.jobId)).toEqual(["j1", "j2", "j3"]);
  });

  it("서로 다른 계정은 credentialId 순으로 안정 정렬된다", () => {
    const cred = (id: string) => ({ id, tenant_id: T1, municipality_id: MUNI, status: "ok" });
    const { groups } = groupPrecheckJobsByCredential(
      [
        jobRow({ jobId: "j1", credential: cred("c-b"), request: { id: "r1", tenant_id: T1, municipality_id: MUNI, credential_id: "c-b" } }),
        jobRow({ jobId: "j2", credential: cred("c-a"), request: { id: "r2", tenant_id: T1, municipality_id: MUNI, credential_id: "c-a" } }),
      ],
      { municipalityId: MUNI },
    );
    expect(groups.map((g) => g.credentialId)).toEqual(["c-a", "c-b"]);
  });

  it("pending/queued 가 아닌 잡은 대상에서 제외한다", () => {
    const { groups, rejected } = groupPrecheckJobsByCredential(
      [
        jobRow({ jobId: "j1", status: "queued" }),
        jobRow({ jobId: "j2", status: "submitted" }),
        jobRow({ jobId: "j3", status: "needs_manual" }),
      ],
      { municipalityId: MUNI },
    );
    expect(rejected).toEqual([]);
    expect(groups[0]!.jobs.map((j) => j.jobId)).toEqual(["j1"]);
  });

  it("계정 미등록 요청은 로그인 대상이 아니라 rejected", () => {
    const { groups, rejected } = groupPrecheckJobsByCredential(
      [jobRow({ jobId: "j1", request: { id: "r1", tenant_id: T1, municipality_id: MUNI, credential_id: null }, credential: null })],
      { municipalityId: MUNI },
    );
    expect(groups).toEqual([]);
    expect(rejected[0]).toMatchObject({ jobId: "j1", reason: "credential_missing", code: "login_failed" });
  });

  it("테넌트 불일치 계정/요청은 rejected (service_role 우회 방어)", () => {
    const crossTenantCred = jobRow({ jobId: "j1" });
    crossTenantCred.credential = { id: "c-1", tenant_id: T2, municipality_id: MUNI, status: "ok" };
    const crossTenantReq = jobRow({ jobId: "j2" });
    crossTenantReq.request = { id: "r2", tenant_id: T2, municipality_id: MUNI, credential_id: "c-1" };

    const { groups, rejected } = groupPrecheckJobsByCredential([crossTenantCred, crossTenantReq], {
      municipalityId: MUNI,
    });
    expect(groups).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual(["reference_invalid", "reference_invalid"]);
  });

  it("타 지자체 계정/요청은 rejected", () => {
    const otherMuniCred = jobRow({ jobId: "j1" });
    otherMuniCred.credential = { id: "c-1", tenant_id: T1, municipality_id: "m-other", status: "ok" };
    const otherMuniReq = jobRow({ jobId: "j2" });
    otherMuniReq.request = { id: "r2", tenant_id: T1, municipality_id: "m-other", credential_id: "c-1" };

    const { groups, rejected } = groupPrecheckJobsByCredential([otherMuniCred, otherMuniReq], {
      municipalityId: MUNI,
    });
    expect(groups).toEqual([]);
    expect(rejected).toHaveLength(2);
  });

  it("request.credential_id 와 다른 계정 행이 오면 rejected", () => {
    const row = jobRow({ jobId: "j1" });
    row.credential = { id: "c-other", tenant_id: T1, municipality_id: MUNI, status: "ok" };
    const { groups, rejected } = groupPrecheckJobsByCredential([row], { municipalityId: MUNI });
    expect(groups).toEqual([]);
    expect(rejected[0]!.reason).toBe("credential_missing");
  });
});

describe("planCredentialPrecheck", () => {
  const NOW = Date.parse("2026-08-01T00:00:00Z");
  const rec = (over: Partial<PrecheckRecord> & { status: PrecheckRecordStatus }): PrecheckRecord => ({
    attempts: 1,
    lastAttemptAt: new Date(NOW).toISOString(),
    ...over,
  });

  it("레코드가 없으면 신규 클레임", () => {
    expect(planCredentialPrecheck(null, { nowMs: NOW })).toEqual({ action: "claim", reclaim: false });
  });

  it("확정된 결과(ok/invalid/locked/error)는 재로그인하지 않는다", () => {
    for (const status of ["ok", "invalid", "locked", "error"] as const) {
      expect(planCredentialPrecheck(rec({ status }), { nowMs: NOW })).toEqual({
        action: "reapply_terminal",
        outcome: status,
        reclaim: false,
      });
    }
  });

  it("terminal 실패는 시간이 아무리 지나도 재로그인하지 않는다", () => {
    expect(
      planCredentialPrecheck(rec({ status: "invalid" }), { nowMs: NOW + 30 * 24 * 3600_000 }).action,
    ).toBe("reapply_terminal");
  });

  it("진행 중(running) 레코드는 건드리지 않는다", () => {
    expect(planCredentialPrecheck(rec({ status: "running" }), { nowMs: NOW + 60_000 }).action).toBe(
      "skip_running",
    );
  });

  it("죽은 running 레코드는 stale 시간 이후 회수한다", () => {
    expect(planCredentialPrecheck(rec({ status: "running" }), { nowMs: NOW + PRECHECK_STALE_MS })).toEqual({
      action: "claim",
      reclaim: true,
    });
  });

  it("사이트 오류(error)도 terminal — 시간이 지나도 재로그인하지 않는다", () => {
    expect(planCredentialPrecheck(rec({ status: "error" }), { nowMs: NOW + 60_000 }).action).toBe(
      "reapply_terminal",
    );
    expect(
      planCredentialPrecheck(rec({ status: "error" }), { nowMs: NOW + 100 * PRECHECK_STALE_MS }).action,
    ).toBe("reapply_terminal");
  });

  it("회수 시도 횟수를 소진하면 죽은 running 도 더 이상 잡지 않는다", () => {
    expect(
      planCredentialPrecheck(rec({ status: "running", attempts: PRECHECK_MAX_ATTEMPTS }), {
        nowMs: NOW + 10 * PRECHECK_STALE_MS,
      }).action,
    ).toBe("skip_exhausted");
  });

  it("파싱 불가 시각은 보수적으로 '방금'으로 본다", () => {
    expect(planCredentialPrecheck(rec({ status: "running", lastAttemptAt: "not-a-date" }), { nowMs: NOW }).action).toBe(
      "skip_running",
    );
  });
});

describe("canStartSubmission — 제출 상태 가드", () => {
  it("pending/queued 만 자동 제출을 시작할 수 있다", () => {
    expect(SUBMITTABLE_STATUSES).toEqual(["pending", "queued"]);
    expect(canStartSubmission("pending")).toBe(true);
    expect(canStartSubmission("queued")).toBe(true);
  });

  it("needs_manual 은 절대 자동 제출되지 않는다", () => {
    expect(canStartSubmission("needs_manual")).toBe(false);
  });

  it("이미 실행/종료된 잡과 알 수 없는 값도 막는다", () => {
    for (const s of ["running", "awaiting_captcha", "submitted", "failed", "cancelled", "", "bogus"]) {
      expect(canStartSubmission(s)).toBe(false);
    }
  });
});

// ===========================================================================
// runWindowPrecheck — 가짜 포트 (실제 지자체 사이트에 접속하지 않는다)
// ===========================================================================

interface FakeOptions {
  health?: { ok: boolean; failures: Array<{ check: string }> };
  jobs?: PrecheckJobRow[];
  /** credentialId → 로그인 시 던질 오류 (없으면 성공) */
  loginFailures?: Record<string, unknown>;
  /** credentialId → 로그인 시 던질 오류를 "인프라 오류"로 승격 (finishPrecheck 실패 시뮬레이션) */
  failFinishFor?: string[];
  /** true 면 첫 markJobsNeedsManual 호출만 실패시킨다(알림-잡전환 사이 크래시 재현) */
  failFirstJobUpdate?: boolean;
  nowMs?: number;
}

function makeFake(opts: FakeOptions = {}) {
  const state = {
    logins: [] as string[],
    prechecks: new Map<string, PrecheckRecord & { checkedAt: string | null; outcomeCode: string | null }>(),
    credentialStatus: new Map<string, { status: string; at: string }>(),
    jobPatches: [] as Array<{ jobIds: string[]; code: string; detail: string }>,
    /** DB unique(type, ref_id, channel, user_id) 를 흉내낸 멱등 저장소 */
    notifications: new Map<string, PrecheckNotification>(),
    municipalityBroken: false,
    logs: [] as Array<{ level: string; event: string; fields: Record<string, unknown> }>,
    jobs: opts.jobs ?? [],
    jobUpdateCalls: 0,
    nowMs: opts.nowMs ?? Date.parse("2026-08-01T00:00:00Z"),
  };
  const key = (c: string) => `${WINDOW}::${c}`;

  const ports: PrecheckPorts = {
    async loadWindow(id) {
      return id === WINDOW ? { id: WINDOW, municipality_id: MUNI } : null;
    },
    async loadMunicipality(id) {
      return id === MUNI ? { id: MUNI, adapter_key: "fake" } : null;
    },
    async healthCheck() {
      return opts.health ?? { ok: true, failures: [] };
    },
    async markMunicipalityBroken() {
      state.municipalityBroken = true;
    },
    async loadCandidateJobs() {
      return state.jobs;
    },
    async readPrecheck(_w, c) {
      return state.prechecks.get(key(c)) ?? null;
    },
    async claimPrecheck({ credentialId, nowIso }) {
      if (state.prechecks.has(key(credentialId))) return false; // unique 충돌
      state.prechecks.set(key(credentialId), {
        status: "running",
        attempts: 1,
        lastAttemptAt: nowIso,
        checkedAt: null,
        outcomeCode: null,
      });
      return true;
    },
    async reclaimPrecheck({ credentialId, expectedStatus, expectedAttempts, nowIso }) {
      const cur = state.prechecks.get(key(credentialId));
      if (!cur || cur.status !== expectedStatus || cur.attempts !== expectedAttempts) return false; // CAS 실패
      state.prechecks.set(key(credentialId), {
        ...cur,
        status: "running",
        attempts: cur.attempts + 1,
        lastAttemptAt: nowIso,
      });
      return true;
    },
    async finishPrecheck({ credentialId, expectedAttempts, outcome, code, nowIso }) {
      if (opts.failFinishFor?.includes(credentialId)) {
        throw new Error(`credential_prechecks update 실패 (${credentialId})`);
      }
      // DB 와 같은 CAS: running + 그 시점 attempts 인 행만 갱신, 0행이면 throw.
      const cur = state.prechecks.get(key(credentialId));
      if (!cur || cur.status !== "running" || cur.attempts !== expectedAttempts) {
        throw new Error(`credential_prechecks 결과 기록 0행 (${credentialId}, attempts=${expectedAttempts})`);
      }
      state.prechecks.set(key(credentialId), {
        status: outcome,
        attempts: cur.attempts,
        lastAttemptAt: nowIso,
        checkedAt: nowIso,
        outcomeCode: code,
      });
    },
    async login(credentialId) {
      state.logins.push(credentialId);
      const failure = opts.loginFailures?.[credentialId];
      if (failure !== undefined) throw failure;
    },
    async markCredentialStatus(credentialId, status, nowIso) {
      state.credentialStatus.set(credentialId, { status, at: nowIso });
    },
    async markJobsNeedsManual(jobIds, code, detail) {
      state.jobUpdateCalls += 1;
      if (opts.failFirstJobUpdate && state.jobUpdateCalls === 1) {
        throw new Error("submission_jobs update 실패(일시)");
      }
      state.jobPatches.push({ jobIds: [...jobIds], code, detail });
      // status 가드를 포함한 DB 동작 재현: 실제로 전환된 id 만 돌려준다.
      const updated: string[] = [];
      for (const id of jobIds) {
        const job = state.jobs.find((j) => j.jobId === id);
        if (!job || (job.status !== "pending" && job.status !== "queued")) continue;
        job.status = "needs_manual";
        updated.push(id);
      }
      return updated;
    },
    async notifyPrecheckFailed(items) {
      for (const item of items) {
        const k = `precheck_failed::${item.jobId}::email::null`;
        if (!state.notifications.has(k)) state.notifications.set(k, item); // ignoreDuplicates
      }
    },
    now: () => state.nowMs,
    log: (level, event, fields) => state.logs.push({ level, event, fields }),
  };
  return { ports, state };
}

/** 계정 c 를 쓰는 잡 하나 */
function jobFor(jobId: string, credentialId: string, tenantId = T1): PrecheckJobRow {
  return {
    jobId,
    tenantId,
    status: "pending",
    requestId: `r-${jobId}`,
    request: { id: `r-${jobId}`, tenant_id: tenantId, municipality_id: MUNI, credential_id: credentialId },
    credential: { id: credentialId, tenant_id: tenantId, municipality_id: MUNI, status: "unverified" },
  };
}

const LOGIN_FAILED = { code: "login_failed", message: "로그인 실패 — 아이디/비밀번호 확인 필요" };
const LOCKED = { code: "login_failed", message: "계정 잠금 5회 초과" };

describe("runWindowPrecheck — 로그인 성공", () => {
  it("성공하면 계정 상태를 ok 로 바꾸고 잡은 그대로 둔다", async () => {
    const { ports, state } = makeFake({ jobs: [jobFor("j1", "c-1")] });
    const summary = await runWindowPrecheck(ports, WINDOW);

    expect(summary.healthOk).toBe(true);
    expect(summary.loginsAttempted).toBe(1);
    expect(summary.outcomes).toEqual({ "c-1": "ok" });
    expect(state.credentialStatus.get("c-1")?.status).toBe("ok");
    expect(state.credentialStatus.get("c-1")?.at).toBe(new Date(state.nowMs).toISOString());
    expect(state.jobPatches).toEqual([]);
    expect(state.notifications.size).toBe(0);
    expect(state.prechecks.get(`${WINDOW}::c-1`)?.status).toBe("ok");
  });

  it("창구/지자체가 없으면 아무 것도 하지 않는다", async () => {
    const { ports, state } = makeFake({ jobs: [jobFor("j1", "c-1")] });
    const summary = await runWindowPrecheck(ports, "w-missing");
    expect(summary.skipped).toBe(true);
    expect(state.logins).toEqual([]);
  });
});

describe("runWindowPrecheck — 로그인 실패", () => {
  it("invalid: 계정과 그 계정의 잡만 격리하고 멱등 알림을 만든다", async () => {
    const { ports, state } = makeFake({
      jobs: [jobFor("j1", "c-1")],
      loginFailures: { "c-1": LOGIN_FAILED },
    });
    const summary = await runWindowPrecheck(ports, WINDOW);

    expect(summary.outcomes).toEqual({ "c-1": "invalid" });
    expect(summary.blockedJobIds).toEqual(["j1"]);
    expect(state.credentialStatus.get("c-1")?.status).toBe("invalid");
    expect(state.jobPatches).toEqual([
      { jobIds: ["j1"], code: "login_failed", detail: PRECHECK_MESSAGES.invalid },
    ]);
    expect(state.notifications.size).toBe(1);
    expect([...state.notifications.values()][0]!.payload).toEqual({ reason: "invalid", windowId: WINDOW });
  });

  it("locked: 어댑터 근거가 있으면 invalid 와 구분한다", async () => {
    const { ports, state } = makeFake({ jobs: [jobFor("j1", "c-1")], loginFailures: { "c-1": LOCKED } });
    const summary = await runWindowPrecheck(ports, WINDOW);

    expect(summary.outcomes).toEqual({ "c-1": "locked" });
    expect(state.credentialStatus.get("c-1")?.status).toBe("locked");
    expect(state.jobPatches[0]!.detail).toBe(PRECHECK_MESSAGES.locked);
  });

  it("사이트/인프라 오류는 계정을 invalid 로 만들지 않지만 잡은 격리한다", async () => {
    const { ports, state } = makeFake({
      jobs: [jobFor("j1", "c-1")],
      loginFailures: { "c-1": { code: "network", message: "ETIMEDOUT" } },
    });
    const summary = await runWindowPrecheck(ports, WINDOW);

    expect(summary.outcomes).toEqual({ "c-1": "error" });
    expect(state.credentialStatus.size).toBe(0); // 계정 상태는 건드리지 않는다
    expect(summary.blockedJobIds).toEqual(["j1"]);
    expect(state.jobPatches).toEqual([
      { jobIds: ["j1"], code: "site_down", detail: PRECHECK_MESSAGES.error },
    ]);
    expect(state.notifications.size).toBe(1);
    expect([...state.notifications.values()][0]!.payload).toEqual({ reason: "error", windowId: WINDOW });
    expect(state.prechecks.get(`${WINDOW}::c-1`)?.status).toBe("error");
  });

  it("복호화·셀렉터·캡차 오류도 확인 실패로 보고 잡을 격리한다", async () => {
    for (const failure of [
      new Error("CREDENTIALS_ENC_KEY 복호화 실패"),
      { code: "selector_missing", message: "no #login_id" },
      { code: "captcha_timeout", message: "사전 점검 중 캡차" },
    ]) {
      const { ports, state } = makeFake({
        jobs: [jobFor("j1", "c-1")],
        loginFailures: { "c-1": failure },
      });
      const summary = await runWindowPrecheck(ports, WINDOW);

      expect(summary.outcomes).toEqual({ "c-1": "error" });
      expect(state.credentialStatus.size).toBe(0);
      expect(summary.blockedJobIds).toEqual(["j1"]);
      expect(state.notifications.size).toBe(1);
    }
  });

  it("저장/알림 문구에 계정·비밀번호가 섞이지 않는다", async () => {
    const { ports, state } = makeFake({
      jobs: [jobFor("j1", "c-1")],
      loginFailures: { "c-1": { code: "login_failed", message: "id=hong pw=s3cr3t 로그인 실패" } },
    });
    await runWindowPrecheck(ports, WINDOW);

    const stored = JSON.stringify([...state.jobPatches, [...state.notifications.values()], state.logs]);
    expect(stored).not.toContain("s3cr3t");
    expect(stored).not.toContain("hong");
  });
});

describe("runWindowPrecheck — 계정 공유와 실패 격리", () => {
  it("같은 계정을 공유하는 여러 잡에 로그인은 1회만 한다", async () => {
    const { ports, state } = makeFake({
      jobs: [jobFor("j1", "c-1"), jobFor("j2", "c-1", T1), jobFor("j3", "c-1")],
    });
    const summary = await runWindowPrecheck(ports, WINDOW);

    expect(state.logins).toEqual(["c-1"]);
    expect(summary.loginsAttempted).toBe(1);
  });

  it("공유 계정이 실패하면 그 계정의 잡 전부가 한 번에 격리된다", async () => {
    const { ports, state } = makeFake({
      jobs: [jobFor("j1", "c-1"), jobFor("j2", "c-1")],
      loginFailures: { "c-1": LOGIN_FAILED },
    });
    const summary = await runWindowPrecheck(ports, WINDOW);

    expect(state.logins).toEqual(["c-1"]);
    expect(summary.blockedJobIds).toEqual(["j1", "j2"]);
    expect(state.notifications.size).toBe(2);
  });

  it("한 계정이 실패해도 다른 계정 점검은 계속된다", async () => {
    const { ports, state } = makeFake({
      jobs: [jobFor("j1", "c-a"), jobFor("j2", "c-b"), jobFor("j3", "c-c")],
      loginFailures: { "c-b": LOGIN_FAILED },
    });
    const summary = await runWindowPrecheck(ports, WINDOW);

    expect(state.logins).toEqual(["c-a", "c-b", "c-c"]);
    expect(summary.outcomes).toEqual({ "c-a": "ok", "c-b": "invalid", "c-c": "ok" });
    expect(summary.blockedJobIds).toEqual(["j2"]); // 실패 계정의 잡만
    expect(state.credentialStatus.get("c-a")?.status).toBe("ok");
    expect(state.credentialStatus.get("c-c")?.status).toBe("ok");
  });

  it("한 계정의 인프라 오류는 다른 계정을 막지 않고, 마지막에 실패로 전파된다", async () => {
    const { ports, state } = makeFake({
      jobs: [jobFor("j1", "c-a"), jobFor("j2", "c-b")],
      failFinishFor: ["c-a"],
    });
    await expect(runWindowPrecheck(ports, WINDOW)).rejects.toThrow(/credential_prechecks update 실패/);
    expect(state.logins).toEqual(["c-a", "c-b"]);
    expect(state.credentialStatus.get("c-b")?.status).toBe("ok");
  });
});

describe("runWindowPrecheck — 멱등성/재시도 안전", () => {
  it("같은 점검을 두 번 돌려도 로그인은 1회, 알림도 1건", async () => {
    const { ports, state } = makeFake({
      jobs: [jobFor("j1", "c-1")],
      loginFailures: { "c-1": LOGIN_FAILED },
    });
    await runWindowPrecheck(ports, WINDOW);
    const second = await runWindowPrecheck(ports, WINDOW);

    expect(state.logins).toEqual(["c-1"]); // terminal 이후 재로그인 없음
    // 1회차에 needs_manual 로 빠진 잡은 더 이상 점검 후보가 아니다.
    expect(second.outcomes).toEqual({});
    expect(state.notifications.size).toBe(1);
  });

  it("성공 확정 이후 재실행도 재로그인하지 않는다", async () => {
    const { ports, state } = makeFake({ jobs: [jobFor("j1", "c-1")] });
    await runWindowPrecheck(ports, WINDOW);
    await runWindowPrecheck(ports, WINDOW);
    expect(state.logins).toEqual(["c-1"]);
  });

  it("확정된 실패 이후 새로 생긴 잡도 재로그인 없이 격리된다", async () => {
    const { ports, state } = makeFake({
      jobs: [jobFor("j1", "c-1")],
      loginFailures: { "c-1": LOGIN_FAILED },
    });
    await runWindowPrecheck(ports, WINDOW);

    state.jobs.push(jobFor("j2", "c-1")); // 나중에 생성된 잡
    const second = await runWindowPrecheck(ports, WINDOW);

    expect(state.logins).toEqual(["c-1"]);
    expect(second.blockedJobIds).toContain("j2");
    expect(state.notifications.size).toBe(2); // 잡별 1건씩, 기존 잡은 중복 없음
  });

  it("다른 워커가 클레임을 선점하면 로그인하지 않는다", async () => {
    const { ports, state } = makeFake({ jobs: [jobFor("j1", "c-1")] });
    state.prechecks.set(`${WINDOW}::c-1`, {
      status: "running",
      attempts: 1,
      lastAttemptAt: new Date(state.nowMs).toISOString(),
      checkedAt: null,
      outcomeCode: null,
    });
    const summary = await runWindowPrecheck(ports, WINDOW);
    expect(state.logins).toEqual([]);
    expect(summary.outcomes).toEqual({ "c-1": "skip_running" });
  });

  it("사이트 오류 이후 새로 생긴 잡도 재로그인 없이 같은 결과로 격리된다", async () => {
    const { ports, state } = makeFake({
      jobs: [jobFor("j1", "c-1")],
      loginFailures: { "c-1": { code: "network", message: "ETIMEDOUT" } },
    });
    await runWindowPrecheck(ports, WINDOW);

    state.nowMs += 100 * PRECHECK_STALE_MS; // 시간이 아무리 지나도 재로그인 없음
    state.jobs.push(jobFor("j2", "c-1"));
    const second = await runWindowPrecheck(ports, WINDOW);

    expect(state.logins).toEqual(["c-1"]);
    expect(second.outcomes).toEqual({ "c-1": "error" });
    expect(second.blockedJobIds).toEqual(["j2"]);
    expect(state.credentialStatus.size).toBe(0); // 인프라 오류로 계정을 탓하지 않는다
    expect(state.notifications.size).toBe(2);
  });

  it("죽은 running 레코드 회수는 시도 횟수 안에서만 한다", async () => {
    const { ports, state } = makeFake({ jobs: [jobFor("j1", "c-1")] });
    // 워커가 결과를 쓰지 못하고 죽은 상태를 재현: running 인 채로 stale.
    const stale = () =>
      state.prechecks.set(`${WINDOW}::c-1`, {
        status: "running",
        attempts: state.prechecks.get(`${WINDOW}::c-1`)?.attempts ?? 1,
        lastAttemptAt: new Date(state.nowMs - PRECHECK_STALE_MS).toISOString(),
        checkedAt: null,
        outcomeCode: null,
      });

    const failing: PrecheckPorts = {
      ...ports,
      async finishPrecheck() {
        throw new Error("워커 사망");
      },
    };
    stale();
    await expect(runWindowPrecheck(failing, WINDOW)).rejects.toThrow(/워커 사망/); // attempts 2
    stale();
    await expect(runWindowPrecheck(failing, WINDOW)).rejects.toThrow(/워커 사망/); // attempts 3
    expect(state.logins).toHaveLength(PRECHECK_MAX_ATTEMPTS - 1);

    stale();
    const last = await runWindowPrecheck(ports, WINDOW);
    expect(last.outcomes).toEqual({ "c-1": "skip_exhausted" });
    expect(state.logins).toHaveLength(PRECHECK_MAX_ATTEMPTS - 1); // 더 이상 로그인하지 않는다
  });

  it("회수 시도를 소진한 계정의 잡은 로그인 없이 격리된다(fail-closed)", async () => {
    const { ports, state } = makeFake({ jobs: [jobFor("j1", "c-1")] });
    // 죽은 running 레코드를 최대 시도까지 소진한 상태 — 더 이상 회수하지 않는다.
    state.prechecks.set(`${WINDOW}::c-1`, {
      status: "running",
      attempts: PRECHECK_MAX_ATTEMPTS,
      lastAttemptAt: new Date(state.nowMs - 10 * PRECHECK_STALE_MS).toISOString(),
      checkedAt: null,
      outcomeCode: null,
    });

    const summary = await runWindowPrecheck(ports, WINDOW);

    expect(state.logins).toEqual([]); // 로그인 시도 0회
    expect(summary.outcomes).toEqual({ "c-1": "skip_exhausted" });
    expect(state.credentialStatus.size).toBe(0); // 계정 잘못이 아니므로 상태를 바꾸지 않는다
    expect(summary.blockedJobIds).toEqual(["j1"]);
    expect(state.jobs[0]!.status).toBe("needs_manual");
    expect(state.jobPatches).toEqual([
      { jobIds: ["j1"], code: "site_down", detail: PRECHECK_MESSAGES.error },
    ]);
    expect(state.notifications.size).toBe(1);
    expect([...state.notifications.values()][0]!.payload).toEqual({ reason: "error", windowId: WINDOW });
  });

  it("소진 이후 매시간 재실행은 늦게 생긴 잡도 로그인 0회로 같은 격리를 적용한다", async () => {
    const { ports, state } = makeFake({ jobs: [jobFor("j1", "c-1")] });
    state.prechecks.set(`${WINDOW}::c-1`, {
      status: "running",
      attempts: PRECHECK_MAX_ATTEMPTS,
      lastAttemptAt: new Date(state.nowMs - 10 * PRECHECK_STALE_MS).toISOString(),
      checkedAt: null,
      outcomeCode: null,
    });
    await runWindowPrecheck(ports, WINDOW);

    state.nowMs += PRECHECK_BUCKET_MS; // 다음 시간 버킷의 사전 점검 잡
    state.jobs.push(jobFor("j2", "c-1")); // 첫 점검 이후 생성된 잡
    const second = await runWindowPrecheck(ports, WINDOW);

    expect(state.logins).toEqual([]);
    expect(second.outcomes).toEqual({ "c-1": "skip_exhausted" });
    expect(second.blockedJobIds).toEqual(["j2"]); // 이미 격리된 j1 은 후보가 아니다
    expect(state.credentialStatus.size).toBe(0);
    expect(state.notifications.size).toBe(2); // 잡별 1건, 기존 잡 중복 없음
  });

  it("클레임을 뺏기면 결과를 기록하지 않고 실패한다(낡은 결과 덮어쓰기 방지)", async () => {
    const { ports, state } = makeFake({ jobs: [jobFor("j1", "c-1")] });
    const stolen: PrecheckPorts = {
      ...ports,
      async login(credentialId) {
        await ports.login(credentialId);
        // 로그인 도중 다른 워커가 stale 회수로 attempts 를 올려 클레임을 가져갔다.
        const cur = state.prechecks.get(`${WINDOW}::c-1`)!;
        state.prechecks.set(`${WINDOW}::c-1`, { ...cur, attempts: cur.attempts + 1 });
      },
    };
    await expect(runWindowPrecheck(stolen, WINDOW)).rejects.toThrow(/결과 기록 0행/);
    expect(state.prechecks.get(`${WINDOW}::c-1`)?.status).toBe("running");
  });

  it("알림과 잡 전환 사이에서 실패해도 재시도하면 잡 격리 1회, 알림 1건", async () => {
    const { ports, state } = makeFake({
      jobs: [jobFor("j1", "c-1")],
      loginFailures: { "c-1": LOGIN_FAILED },
      failFirstJobUpdate: true,
    });
    // 1회차: 알림은 만들어졌지만 잡 전환 직전에 실패 → 잡 실패로 전파(재시도 대상).
    await expect(runWindowPrecheck(ports, WINDOW)).rejects.toThrow(/submission_jobs update 실패/);
    expect(state.notifications.size).toBe(1);
    expect(state.jobs[0]!.status).toBe("pending"); // 아직 격리되지 않았다

    // 2회차(BullMQ 재시도): 재로그인 없이 확정 결과를 재적용해 잡을 마저 격리한다.
    const retry = await runWindowPrecheck(ports, WINDOW);
    expect(state.logins).toEqual(["c-1"]);
    expect(retry.blockedJobIds).toEqual(["j1"]);
    expect(state.jobs[0]!.status).toBe("needs_manual");
    expect(state.notifications.size).toBe(1); // 멱등키 덕분에 중복 없음
    expect(state.credentialStatus.get("c-1")?.status).toBe("invalid");
  });

  it("재적용은 저장된 확정 시각으로 계정 상태를 복구한다", async () => {
    const { ports, state } = makeFake({ jobs: [jobFor("j1", "c-1")] });
    // 로그인은 성공했지만 계정 상태 갱신 직전에 워커가 죽은 상태를 재현.
    const crashed: PrecheckPorts = {
      ...ports,
      async markCredentialStatus() {
        throw new Error("site_credentials 갱신 실패");
      },
    };
    await expect(runWindowPrecheck(crashed, WINDOW)).rejects.toThrow(/site_credentials 갱신 실패/);
    const checkedAt = state.prechecks.get(`${WINDOW}::c-1`)!.checkedAt;
    expect(state.credentialStatus.size).toBe(0);

    state.nowMs += 3 * 3600_000; // 재시도는 한참 뒤에 돈다
    const retry = await runWindowPrecheck(ports, WINDOW);

    expect(state.logins).toEqual(["c-1"]); // 재로그인 없음
    expect(retry.outcomes).toEqual({ "c-1": "ok" });
    // last_login_ok_at 은 "지금"이 아니라 실제로 로그인에 성공한 시각이어야 한다.
    expect(state.credentialStatus.get("c-1")).toEqual({ status: "ok", at: checkedAt });
  });
});

describe("precheckJobId", () => {
  const base = Date.parse("2026-08-01T00:00:00Z");

  it("같은 시간 안에서는 같은 jobId(중복 큐잉 차단)", () => {
    expect(precheckJobId(WINDOW, base)).toBe(precheckJobId(WINDOW, base + PRECHECK_BUCKET_MS - 1));
  });

  it("시간이 바뀌면 jobId 도 바뀌어 늦게 생긴 잡까지 다시 덮는다", () => {
    expect(precheckJobId(WINDOW, base)).not.toBe(precheckJobId(WINDOW, base + PRECHECK_BUCKET_MS));
  });

  it("창구마다 다르고 BullMQ 가 금지하는 콜론이 없다", () => {
    expect(precheckJobId("w-1", base)).not.toBe(precheckJobId("w-2", base));
    expect(precheckJobId(WINDOW, base)).not.toContain(":");
  });
});

describe("runWindowPrecheck — 사이트 헬스체크 실패 (fail-closed)", () => {
  const health = { ok: false, failures: [{ check: "login_form" }, { check: "board_list" }] };

  it("지자체를 broken 으로 표시하고 창구의 잡 전부를 격리한다", async () => {
    const { ports, state } = makeFake({
      health,
      jobs: [jobFor("j1", "c-1"), jobFor("j2", "c-2"), { ...jobFor("j3", "c-3"), status: "submitted" }],
    });
    const summary = await runWindowPrecheck(ports, WINDOW);

    expect(state.municipalityBroken).toBe(true);
    expect(summary.healthOk).toBe(false);
    expect(state.logins).toEqual([]); // 로그인 시도 자체를 하지 않는다
    expect(summary.blockedJobIds).toEqual(["j1", "j2"]); // pending/queued 만
    expect(state.jobPatches).toEqual([
      { jobIds: ["j1", "j2"], code: "site_down", detail: PRECHECK_MESSAGES.site_down },
    ]);
    expect(state.notifications.size).toBe(2);
    expect([...state.notifications.values()][0]!.payload).toEqual({
      reason: "site_down",
      windowId: WINDOW,
      checks: ["login_form", "board_list"],
    });
  });

  it("헬스체크 실패 알림은 반복 실행해도 잡당 1건", async () => {
    const { ports, state } = makeFake({ health, jobs: [jobFor("j1", "c-1")] });
    await runWindowPrecheck(ports, WINDOW);
    await runWindowPrecheck(ports, WINDOW);
    expect(state.notifications.size).toBe(1);
  });
});

describe("runWindowPrecheck — 참조 위반 잡", () => {
  it("계정 미등록/참조 위반 잡은 사이트 접속 없이 격리된다", async () => {
    const missing = jobFor("j1", "c-1");
    missing.request = { id: "r-j1", tenant_id: T1, municipality_id: MUNI, credential_id: null };
    missing.credential = null;
    const crossTenant = jobFor("j2", "c-2");
    crossTenant.credential = { id: "c-2", tenant_id: T2, municipality_id: MUNI, status: "ok" };

    const { ports, state } = makeFake({ jobs: [missing, crossTenant, jobFor("j3", "c-3")] });
    const summary = await runWindowPrecheck(ports, WINDOW);

    expect(summary.rejectedJobs).toBe(2);
    expect(state.logins).toEqual(["c-3"]); // 정상 계정만 로그인
    expect(state.jobPatches).toEqual([
      { jobIds: ["j1"], code: "login_failed", detail: PRECHECK_MESSAGES.credential_missing },
      { jobIds: ["j2"], code: "validation_rejected", detail: PRECHECK_MESSAGES.reference_invalid },
    ]);
    expect(state.notifications.size).toBe(2);
  });
});

describe("runWindowPrecheck — DB 오류 전파 (fail-closed)", () => {
  it("후보 잡 조회 오류를 '대상 없음'으로 삼키지 않는다", async () => {
    const { ports } = makeFake({ jobs: [jobFor("j1", "c-1")] });
    const failing: PrecheckPorts = {
      ...ports,
      async loadCandidateJobs() {
        throw new Error("query failed [submission_jobs]");
      },
    };
    await expect(runWindowPrecheck(failing, WINDOW)).rejects.toThrow(/query failed/);
  });

  it("헬스체크 실패 경로의 잡 갱신 오류도 전파된다", async () => {
    const { ports } = makeFake({
      health: { ok: false, failures: [{ check: "login_form" }] },
      jobs: [jobFor("j1", "c-1")],
    });
    const failing: PrecheckPorts = {
      ...ports,
      async markJobsNeedsManual() {
        throw new Error("submission_jobs update 실패");
      },
    };
    await expect(runWindowPrecheck(failing, WINDOW)).rejects.toThrow(/submission_jobs update 실패/);
  });
});

describe("PRECHECK_MESSAGES", () => {
  it("모든 저장 문구는 고정값이며 자리표시자가 없다", () => {
    for (const [k, v] of Object.entries(PRECHECK_MESSAGES)) {
      expect(v.length, k).toBeGreaterThan(10);
      expect(v, k).not.toMatch(/\$\{|%s/);
    }
  });

  it("outcome 별 문구가 서로 구분된다", () => {
    const outcomes: PrecheckLoginOutcome[] = ["invalid", "locked", "error"];
    const msgs = outcomes.map((o) => PRECHECK_MESSAGES[o]);
    expect(new Set(msgs).size).toBe(msgs.length);
  });
});
