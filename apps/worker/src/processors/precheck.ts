import {
  AdapterError,
  getAdapter,
  stepNameOnlyAuditTrail,
  type MunicipalityAdapter,
  type SubmitContext,
} from "@youni/adapters";
import {
  decryptSecret,
  loadEncKey,
  precheckJobPayloadSchema,
  redactSecrets,
  runWindowPrecheck,
  unwrapQuery,
  type PrecheckJobRow,
  type PrecheckPorts,
  type PrecheckRecord,
  type PrecheckRunSummary,
} from "@youni/core";
import type { ApplicationRequestRow, MunicipalityRow, SiteCredentialRow } from "@youni/db";
import type { Job } from "bullmq";
import { chromium, type Browser } from "playwright";
import { db } from "../db.js";
import { env } from "../env.js";
import { logger } from "../logger.js";

/**
 * D-1 사전 점검 worker (S04).
 *
 * 판정/오케스트레이션은 @youni/core 의 runWindowPrecheck 에 있고, 이 파일은
 * 그 포트를 Supabase/Playwright/어댑터로 구현하는 얇은 배선이다.
 *
 * 비밀 취급 규칙(이 파일이 유일한 접점):
 *   1. 비밀번호 복호화는 adapter.login 호출 "직전"에만 한다.
 *   2. 계정마다 새 BrowserContext + Page 를 열고 끝나면 닫는다 — 계정 간 쿠키/
 *      세션 공유가 구조적으로 불가능하다.
 *   3. 감사 증적은 단계 이름만 남긴다(stepNameOnlyAuditTrail) — 로그인 화면
 *      스크린샷/HTML 을 캡처하지도, 저장하지도 않는다.
 *   4. 로그·DB 에 남는 문자열은 어댑터 원문 대신 고정 문구이며, 진단 로그는
 *      redactSecrets 로 아이디/비밀번호를 마스킹한 뒤 남긴다.
 */
/**
 * 어댑터가 넘기는 자유 문자열은 사전 점검에서 버린다(no-op).
 *
 * 다른 워커와 달리 precheck 는 로그인 화면 위에서 돈다 — 어댑터가 만든 메시지에
 * 입력한 아이디, 폼 값, 응답 본문 조각이 섞여 들어올 수 있고 로그는 지우기 어렵다.
 * 진행 상황은 어댑터 문자열이 아니라 이 파일이 직접 남기는 고정 이벤트(precheck.*)와
 * 단계 이름만 남기는 감사 증적으로 충분히 추적된다.
 */
const adapterLogSink = (): void => {};

export async function processPrecheckJob(bullJob: Job): Promise<void> {
  const payload = precheckJobPayloadSchema.parse(bullJob.data);
  const browser = await chromium.launch({ headless: true });
  try {
    const summary = await runWindowPrecheck(await buildPorts(payload.windowId, browser), payload.windowId);
    logSummary(summary);
  } finally {
    await browser.close().catch(() => {});
  }
}

function logSummary(summary: PrecheckRunSummary): void {
  logger.info(
    {
      windowId: summary.windowId,
      healthOk: summary.healthOk,
      logins: summary.loginsAttempted,
      outcomes: summary.outcomes,
      blockedJobs: summary.blockedJobIds.length,
      rejectedJobs: summary.rejectedJobs,
    },
    "precheck 완료",
  );
}

/**
 * 포트 구현. 창구/지자체를 먼저 읽어 어댑터를 고정하고, 이후 조회/쓰기는 모두
 * unwrapQuery(또는 명시적 error 검사)로 오류를 throw 한다 — "행 없음"과 절대
 * 섞지 않는다(fail-closed).
 */
async function buildPorts(windowId: string, browser: Browser): Promise<PrecheckPorts> {
  // 어댑터는 창구의 지자체가 확정된 뒤에만 필요하므로 지연 초기화한다.
  let adapter: MunicipalityAdapter | null = null;

  return {
    async loadWindow(id) {
      const res = await db()
        .from("application_windows")
        .select("id, municipality_id")
        .eq("id", id)
        .maybeSingle();
      return unwrapQuery(res, `application_windows(${id})`) as { id: string; municipality_id: string } | null;
    },

    async loadMunicipality(municipalityId) {
      const res = await db().from("municipalities").select("*").eq("id", municipalityId).maybeSingle();
      const muni = unwrapQuery(res, `municipalities(${municipalityId})`) as MunicipalityRow | null;
      if (!muni) return null;
      adapter = getAdapter(muni.adapter_key);
      return { id: muni.id, adapter_key: muni.adapter_key };
    },

    async healthCheck() {
      // 창구 단위 사이트 점검은 기존 adapter.healthCheck 를 그대로 쓴다(로그인 없음).
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const report = await adapter!.healthCheck({
          page,
          audit: stepNameOnlyAuditTrail(),
          log: adapterLogSink,
        });
        // 실패 detail 원문(URL/예외 문자열)은 코어로 넘기지 않는다 — 점검 이름만.
        return { ok: report.ok, failures: report.failures.map((f) => ({ check: f.check })) };
      } finally {
        await context.close().catch(() => {});
      }
    },

    async markMunicipalityBroken(municipalityId) {
      const { error } = await db().from("municipalities").update({ status: "broken" }).eq("id", municipalityId);
      if (error) throw new Error(`municipalities broken 표시 실패 (${municipalityId}): ${error.message}`);
    },

    loadCandidateJobs,

    async readPrecheck(wid, credentialId) {
      const res = await db()
        .from("credential_prechecks")
        .select("status, attempts, last_attempt_at, checked_at, outcome_code")
        .eq("window_id", wid)
        .eq("credential_id", credentialId)
        .maybeSingle();
      const row = unwrapQuery(res, `credential_prechecks(${wid},${credentialId})`) as {
        status: PrecheckRecord["status"];
        attempts: number;
        last_attempt_at: string;
        checked_at: string | null;
        outcome_code: string | null;
      } | null;
      return row
        ? {
            status: row.status,
            attempts: row.attempts,
            lastAttemptAt: row.last_attempt_at,
            checkedAt: row.checked_at,
            outcomeCode: row.outcome_code,
          }
        : null;
    },

    async claimPrecheck({ windowId: wid, credentialId, tenantId, municipalityId, nowIso }) {
      const { error } = await db().from("credential_prechecks").insert({
        window_id: wid,
        credential_id: credentialId,
        tenant_id: tenantId,
        municipality_id: municipalityId,
        status: "running",
        attempts: 1,
        last_attempt_at: nowIso,
      });
      // unique(window_id, credential_id) 위반 = 다른 워커/이전 실행이 이미 클레임 → 로그인 금지.
      if (error?.code === "23505") return false;
      if (error) {
        throw new Error(`credential_prechecks 클레임 실패 (${wid},${credentialId}): ${error.message}`);
      }
      return true;
    },

    async reclaimPrecheck({ windowId: wid, credentialId, expectedStatus, expectedAttempts, nowIso }) {
      // CAS: 읽은 그대로일 때만 회수. 0행이면 다른 워커가 선점한 것 → 로그인하지 않는다.
      const { data, error } = await db()
        .from("credential_prechecks")
        .update({ status: "running", attempts: expectedAttempts + 1, last_attempt_at: nowIso })
        .eq("window_id", wid)
        .eq("credential_id", credentialId)
        .eq("status", expectedStatus)
        .eq("attempts", expectedAttempts)
        .select("id")
        .maybeSingle();
      if (error) {
        throw new Error(`credential_prechecks 회수 실패 (${wid},${credentialId}): ${error.message}`);
      }
      return data !== null;
    },

    async finishPrecheck({ windowId: wid, credentialId, expectedAttempts, outcome, code, detail, nowIso }) {
      // CAS: 이번 실행이 잡아 둔 클레임(running + 그때의 attempts)일 때만 기록한다.
      // 조건 없이 덮으면 stale 회수로 다른 워커가 이미 다시 점검 중인 행에 낡은
      // 결과를 써 넣게 된다.
      const { data, error } = await db()
        .from("credential_prechecks")
        .update({
          status: outcome,
          outcome_code: code,
          outcome_detail: detail, // 고정 문구만 (PRECHECK_MESSAGES)
          checked_at: nowIso,
          last_attempt_at: nowIso,
        })
        .eq("window_id", wid)
        .eq("credential_id", credentialId)
        .eq("status", "running")
        .eq("attempts", expectedAttempts)
        .select("id")
        .maybeSingle();
      if (error) {
        throw new Error(`credential_prechecks 결과 기록 실패 (${wid},${credentialId}): ${error.message}`);
      }
      if (!data) {
        // 클레임을 잃었거나 행이 사라졌다 = 조용히 성공으로 넘기면 재로그인 위험 → fail-closed.
        throw new Error(
          `credential_prechecks 결과 기록 0행 (${wid},${credentialId}, attempts=${expectedAttempts})`,
        );
      }
    },

    login: (credentialId) => loginWithFreshContext(browser, adapter!, credentialId),

    async markCredentialStatus(credentialId, status, nowIso) {
      const patch: Record<string, unknown> =
        status === "ok" ? { status, last_login_ok_at: nowIso } : { status };
      const { data, error } = await db()
        .from("site_credentials")
        .update(patch)
        .eq("id", credentialId)
        .select("id")
        .maybeSingle();
      if (error) throw new Error(`site_credentials 상태 갱신 실패 (${credentialId}): ${error.message}`);
      // 0행 = 계정이 사라졌다. 조용히 넘기면 "점검 결과 반영됨"으로 오해하게 된다.
      if (!data) throw new Error(`site_credentials 상태 갱신 0행 (${credentialId})`);
    },

    async markJobsNeedsManual(jobIds, code, detail) {
      if (jobIds.length === 0) return [];
      // status 가드: 그 사이 running/submitted 로 넘어간 잡을 되돌리지 않는다.
      // 실제로 갱신된 id 만 돌려준다 — 가드에 걸린 잡은 "막았다"고 보고하지 않는다.
      const { data, error } = await db()
        .from("submission_jobs")
        .update({ status: "needs_manual", error_code: code, error_detail: detail })
        .in("id", jobIds)
        .in("status", ["pending", "queued"])
        .select("id");
      if (error) throw new Error(`submission_jobs needs_manual 전환 실패: ${error.message}`);
      return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    },

    async notifyPrecheckFailed(items) {
      if (items.length === 0) return;
      const { error } = await db()
        .from("notifications")
        .upsert(
          items.map((i) => ({
            tenant_id: i.tenantId,
            channel: "email" as const,
            type: "precheck_failed",
            ref_id: i.jobId,
            payload: i.payload,
          })),
          { onConflict: "type,ref_id,channel,user_id", ignoreDuplicates: true },
        );
      if (error) throw new Error(`precheck_failed 알림 생성 실패: ${error.message}`);
    },

    now: () => Date.now(),

    log: (level, event, fields) => logger[level](fields, event),
  };
}

/**
 * 이 창구의 pending/queued 잡 + application_requests 경유 credential 스냅샷.
 * PostgREST 임베딩 대신 명시적 3단계 조회를 쓴다(조인 문법 의존성 제거, 오류 구분 명확).
 */
async function loadCandidateJobs(windowId: string): Promise<PrecheckJobRow[]> {
  const jobsRes = await db()
    .from("submission_jobs")
    .select("id, tenant_id, status, request_id")
    .eq("window_id", windowId)
    .in("status", ["pending", "queued"]);
  const jobs =
    (unwrapQuery(jobsRes, `submission_jobs(window=${windowId})`) as
      | Array<{ id: string; tenant_id: string; status: string; request_id: string }>
      | null) ?? [];
  if (jobs.length === 0) return [];

  const requestIds = [...new Set(jobs.map((j) => j.request_id))];
  const reqRes = await db()
    .from("application_requests")
    .select("id, tenant_id, municipality_id, credential_id")
    .in("id", requestIds);
  const requests =
    (unwrapQuery(reqRes, `application_requests(window=${windowId})`) as
      | Array<Pick<ApplicationRequestRow, "id" | "tenant_id" | "municipality_id" | "credential_id">>
      | null) ?? [];
  const requestById = new Map(requests.map((r) => [r.id, r]));

  const credentialIds = [
    ...new Set(requests.map((r) => r.credential_id).filter((id): id is string => id !== null)),
  ];
  const credentials: Array<Pick<SiteCredentialRow, "id" | "tenant_id" | "municipality_id" | "status">> =
    credentialIds.length === 0
      ? []
      : ((unwrapQuery(
          await db()
            .from("site_credentials")
            .select("id, tenant_id, municipality_id, status")
            .in("id", credentialIds),
          `site_credentials(window=${windowId})`,
        ) as Array<Pick<SiteCredentialRow, "id" | "tenant_id" | "municipality_id" | "status">> | null) ?? []);
  const credentialById = new Map(credentials.map((c) => [c.id, c]));

  return jobs.map((j) => {
    const request = requestById.get(j.request_id) ?? null;
    const credential = request?.credential_id ? credentialById.get(request.credential_id) ?? null : null;
    return {
      jobId: j.id,
      tenantId: j.tenant_id,
      status: j.status,
      requestId: j.request_id,
      request,
      credential,
    };
  });
}

/**
 * 계정 1개 로그인 시도 — 계정마다 완전히 새로운 BrowserContext/Page.
 * 비밀번호는 adapter.login 직전에만 복호화하고 어디에도 남기지 않는다.
 * 실패는 그대로 throw 해서 코어의 classifyLoginFailure 가 분류하게 한다.
 */
async function loginWithFreshContext(
  browser: Browser,
  adapter: MunicipalityAdapter,
  credentialId: string,
): Promise<void> {
  const credRes = await db()
    .from("site_credentials")
    .select("id, username, password_enc, enc_iv")
    .eq("id", credentialId)
    .maybeSingle();
  const cred = unwrapQuery(credRes, `site_credentials(${credentialId})`) as Pick<
    SiteCredentialRow,
    "id" | "username" | "password_enc" | "enc_iv"
  > | null;
  if (!cred) throw new Error(`site_credentials(${credentialId}) 행 없음 — 사전 점검 불가`);

  // 계정별 격리: 새 컨텍스트 = 새 쿠키/스토리지. 다른 계정 세션이 섞일 수 없다.
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const ctx: SubmitContext = {
      page,
      // 로그인 화면 스크린샷/HTML 을 남기지 않는다 — 단계 이름만.
      audit: stepNameOnlyAuditTrail(),
      log: adapterLogSink,
      dryRun: true, // 사전 점검은 어떤 제출 동작도 하지 않는다
      onCaptcha: () => {
        throw new AdapterError("captcha_timeout", "사전 점검 중 캡차 — 자동 확인 불가", false);
      },
    };

    // 복호화는 여기서 딱 한 번, 바로 다음 줄의 login 호출을 위해서만.
    const password = decryptSecret(
      { iv: cred.enc_iv, data: cred.password_enc },
      loadEncKey(env.CREDENTIALS_ENC_KEY),
    );
    try {
      await adapter.login(ctx, { username: cred.username, password });
    } catch (err) {
      // 진단 로그에도 아이디/비밀번호가 남지 않게 마스킹한다(저장은 하지 않음).
      logger.warn(
        {
          credentialId,
          detail: redactSecrets(err instanceof Error ? err.message : String(err), [
            cred.username,
            password,
          ]),
        },
        "precheck 로그인 실패",
      );
      throw err;
    }
  } finally {
    // 세션 쿠키는 컨텍스트와 함께 폐기 — storageState 를 저장하지 않는다.
    await context.close().catch(() => {});
  }
}
