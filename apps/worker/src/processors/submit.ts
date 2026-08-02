import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdapterError,
  createAuditTrail,
  getAdapter,
  validateDryRunAuditEvidence,
  type AuditEvidence,
  type AuditTrail,
  type SubmissionInput,
  type SubmitContext,
} from "@youni/adapters";
import {
  canStartSubmission,
  checkJobContextIntegrity,
  decryptSecret,
  loadEncKey,
  type SubmissionErrorCode,
} from "@youni/core";
import type {
  AdvertiserProfileRow,
  ApplicationRequestRow,
  BoardSiteRow,
  DesignRow,
  MunicipalityRow,
  SiteCredentialRow,
  SubmissionJobRow,
} from "@youni/db";
import type { Job } from "bullmq";
import { chromium, type Browser } from "playwright";
import { submitJobPayloadSchema } from "@youni/core";
import { storageAuditSink } from "../audit.js";
import { relayCaptcha } from "../captcha.js";
import { db } from "../db.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { getQueue } from "../queues.js";
import {
  effectiveDryRun,
  failureTerminalStatus,
  municipalityRunBlock,
  windowRunTiming,
} from "../rehearsal.js";

/** 오류 유형별 재시도 정책 (지수 백오프는 delay 재큐잉으로 구현) */
const RETRY_DELAYS_MS: Partial<Record<SubmissionErrorCode, number[]>> = {
  network: [60_000, 300_000, 900_000, 3_600_000, 10_800_000],
  site_down: [60_000, 300_000, 900_000, 3_600_000, 10_800_000],
  not_open_yet: [1_800_000], // 30분 폴링 (창구 마감까지 반복)
  captcha_timeout: [3_600_000, 3_600_000, 3_600_000],
};

export async function processSubmitJob(bullJob: Job): Promise<void> {
  const payload = submitJobPayloadSchema.parse(bullJob.data);
  const jobId = payload.submissionJobId;

  const job = await loadJob(jobId);
  if (!job) return;
  // 저장된 상태가 pending/queued 가 아니면 아무 것도 하지 않는다 (S04).
  // 창구 오픈까지 대기하던 delayed BullMQ 잡은 D-1 사전 점검보다 늦게 도착한다.
  // 그 사이 사전 점검이 needs_manual 로 돌린 잡(계정 오류/사이트 장애)이나 운영자가
  // cancelled 로 바꾼 잡이 자동 제출되는 경로를 여기서 끊는다.
  if (!canStartSubmission(job.status)) {
    logger.info({ jobId, status: job.status }, "제출 건너뜀 — 자동 제출 가능 상태가 아님");
    return;
  }

  const ctx = await loadJobContext(job);
  if ("skip" in ctx) {
    await markJob(jobId, { status: "needs_manual", error_code: ctx.code, error_detail: ctx.detail });
    await notify(job.tenant_id, "needs_manual", jobId, { reason: ctx.detail });
    return;
  }

  const runDry = effectiveDryRun(
    env.SUBMIT_DRY_RUN_DEFAULT,
    ctx.request.dry_run_only,
    job.dry_run,
    payload.dryRun,
  );

  const attemptNo = await nextAttemptNo(jobId);
  const screenshots: string[] = [];
  const { data: attempt, error: attemptError } = await db()
    .from("submission_attempts")
    .insert({ job_id: jobId, tenant_id: job.tenant_id, attempt_no: attemptNo, screenshots: [] })
    .select("id")
    .single();
  if (attemptError || !attempt) {
    const detail = `제출 감사 시도 레코드를 생성할 수 없습니다: ${attemptError?.message ?? "unknown"}`;
    await markJob(jobId, {
      status: "needs_manual",
      dry_run: runDry,
      error_code: "audit_incomplete",
      error_detail: detail,
    });
    await notify(job.tenant_id, "needs_manual", jobId, { reason: detail });
    return;
  }

  await markJob(jobId, { status: "running", dry_run: runDry });

  const timing = windowRunTiming(ctx.window.opens_at, ctx.window.closes_at, new Date());
  if (timing !== "open") {
    const beforeOpen = timing === "before";
    await handleFailure(
      job,
      new AdapterError(
        beforeOpen ? "not_open_yet" : "validation_rejected",
        beforeOpen
          ? "접수 창구가 아직 열리지 않았습니다."
          : `접수 창구가 닫혔거나 시각 정보가 유효하지 않습니다 (${timing}).`,
        beforeOpen,
      ),
      attempt.id,
      undefined,
      [],
      [],
      runDry,
    );
    return;
  }

  let browser: Browser | undefined;
  let audit: AuditTrail | undefined;
  let tmpDir: string | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const sink = storageAuditSink(job.tenant_id, jobId, attemptNo, (p) => screenshots.push(p));
    audit = createAuditTrail(page, sink);
    tmpDir = await mkdtemp(join(tmpdir(), "design-"));

    const submitCtx: SubmitContext = {
      page,
      audit,
      log: (msg) => logger.info({ jobId }, msg),
      dryRun: runDry,
      onCaptcha: (img) => relayCaptcha(job.tenant_id, jobId, img),
    };

    const adapter = getAdapter(ctx.municipality.adapter_key);
    const runBlock = municipalityRunBlock(
      ctx.municipality.status,
      runDry,
      adapter.meta.autoSubmit && ctx.municipality.capabilities.autoSubmit,
    );
    if (runBlock) {
      throw new AdapterError(
        runBlock,
        runBlock === "dry_run_safety_violation"
          ? "beta 지자체는 dry-run 리허설로만 실행할 수 있습니다."
          : `municipality ${ctx.municipality.status} is not runnable or auto submit is disabled`,
        false,
      );
    }

    // 시안 다운로드 → 임시 파일 (제출 폼 업로드용)
    const { data: designFile, error: dlErr } = await db()
      .storage.from("designs")
      .download(ctx.design.storage_path);
    if (dlErr || !designFile) throw new AdapterError("unknown", "design download failed", true);
    const designPath = join(tmpDir, ctx.design.file_name);
    await writeFile(designPath, Buffer.from(await designFile.arrayBuffer()));

    // 사이트 계정 복호화 — 제출 직전에만, 메모리에서만
    const password = decryptSecret(
      { iv: ctx.credential.enc_iv, data: ctx.credential.password_enc },
      loadEncKey(env.CREDENTIALS_ENC_KEY),
    );

    await adapter.login(submitCtx, { username: ctx.credential.username, password });
    await db()
      .from("site_credentials")
      .update({ status: "ok", last_login_ok_at: new Date().toISOString() })
      .eq("id", ctx.credential.id);

    const input: SubmissionInput = {
      profile: {
        businessName: ctx.profile.business_name,
        bizRegNo: ctx.profile.biz_reg_no ?? undefined,
        representative: ctx.profile.representative ?? undefined,
        phone: ctx.profile.phone,
        email: ctx.profile.email ?? undefined,
        address: ctx.profile.address ?? undefined,
      },
      boardPreferences: ctx.boardPrefs,
      designFilePath: designPath,
      targetPeriod: { start: ctx.window.target_period_start, end: ctx.window.target_period_end },
    };

    const receipt = await adapter.submitApplication(submitCtx, input);
    if (receipt.dryRun !== runDry) {
      throw new AdapterError(
        "dry_run_safety_violation",
        "adapter 결과의 dry-run 모드가 worker의 안전 모드와 일치하지 않습니다.",
        false,
      );
    }

    const selectedBoardSiteId = ctx.boardPrefs.find(
      (pref) => pref.externalId === receipt.selectedBoardExternalId,
    )?.boardSiteId;

    if (receipt.dryRun) {
      const evidenceValidation = validateDryRunAuditEvidence(audit.evidence);
      if (!evidenceValidation.valid || !selectedBoardSiteId) {
        const missing = evidenceValidation.missingSteps.join(", ");
        throw new AdapterError(
          "audit_incomplete",
          [
            missing ? `필수 리허설 증적 누락: ${missing}` : null,
            selectedBoardSiteId ? null : "선택 게시대 식별 증적 누락",
          ]
            .filter(Boolean)
            .join("; "),
          false,
        );
      }

      const completedAt = new Date().toISOString();
      await finishAttempt(
        attempt.id,
        "dry_run_completed",
        audit.steps.at(-1),
        screenshots,
        audit.evidence,
      );
      await markJob(jobId, {
        status: "dry_run_completed",
        dry_run: true,
        dry_run_completed_at: completedAt,
        submitted_at: null,
        receipt_no: null,
        selected_board_site_id: selectedBoardSiteId,
        error_code: null,
        error_detail: null,
      });
      await notify(job.tenant_id, "dry_run_completed", jobId, {
        dryRun: true,
        board: receipt.selectedBoardExternalId,
        completedAt,
      });
      return;
    }

    await markJob(jobId, {
      status: "submitted",
      submitted_at: receipt.submittedAt,
      receipt_no: receipt.receiptNo ?? null,
      selected_board_site_id: selectedBoardSiteId ?? null,
      error_code: null,
      error_detail: null,
    });
    await finishAttempt(attempt.id, "ok", audit.steps.at(-1), screenshots, audit.evidence);
    await notify(job.tenant_id, "submit_ok", jobId, {
      receiptNo: receipt.receiptNo,
      dryRun: false,
      board: receipt.selectedBoardExternalId,
    });
  } catch (err) {
    await handleFailure(
      job,
      err,
      attempt.id,
      audit?.steps.at(-1),
      screenshots,
      audit?.evidence ?? [],
      runDry,
    );
  } finally {
    await browser?.close().catch(() => {});
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function handleFailure(
  job: SubmissionJobRow,
  err: unknown,
  attemptId: string,
  lastStep: string | undefined,
  screenshots: string[],
  auditEvents: readonly AuditEvidence[],
  runDry: boolean,
): Promise<void> {
  const code: SubmissionErrorCode = err instanceof AdapterError ? err.code : "unknown";
  const detail = err instanceof Error ? err.message : String(err);
  logger.warn({ jobId: job.id, code, detail }, "submit attempt failed");
  try {
    await finishAttempt(attemptId, code, lastStep, screenshots, auditEvents, detail);
  } catch (persistenceError) {
    const persistenceDetail =
      persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
    await markJob(job.id, {
      status: "needs_manual",
      error_code: "audit_incomplete",
      error_detail: persistenceDetail,
    });
    await notify(job.tenant_id, "needs_manual", job.id, { reason: persistenceDetail });
    return;
  }

  const attemptNo = await nextAttemptNo(job.id);
  const delays = RETRY_DELAYS_MS[code];
  const retryIdx = attemptNo - 2; // attempt 1 실패 → 첫 재시도 delay
  const windowStillOpen = await isWindowOpen(job.window_id);

  const canRetry =
    delays !== undefined &&
    windowStillOpen &&
    (code === "not_open_yet" ? true : retryIdx < delays.length);

  if (canRetry) {
    const delay = delays[Math.min(Math.max(retryIdx, 0), delays.length - 1)]!;
    await markJob(job.id, { status: "queued", error_code: code, error_detail: detail });
    await getQueue("submit").add(
      "submit",
      { kind: "submit", submissionJobId: job.id },
      { jobId: `${job.id}-retry-${attemptNo}`, delay, attempts: 1 },
    );
    return;
  }

  // 재시도 불가: 자격 문제/매진/사이트 변경 등 → 상태 분기
  if (code === "login_failed") {
    await db()
      .from("site_credentials")
      .update({ status: "invalid" })
      .eq("id", (await loadRequest(job.request_id))?.credential_id ?? "");
  }
  if (code === "selector_missing") {
    // 사이트 구조 변경 의심 — 지자체 broken 마킹 (운영자 확인 후 복구)
    const req = await loadRequest(job.request_id);
    if (req) {
      await db().from("municipalities").update({ status: "broken" }).eq("id", req.municipality_id);
    }
  }

  const terminal = failureTerminalStatus(code, windowStillOpen, runDry);
  await markJob(job.id, { status: terminal, error_code: code, error_detail: detail });
  const notificationType =
    terminal === "needs_manual" ? "needs_manual" : terminal === "submitted" ? "submit_ok" : "submit_fail";
  await notify(job.tenant_id, notificationType, job.id, { code, detail });
}

// ---------- helpers ----------

interface JobContext {
  request: ApplicationRequestRow;
  municipality: MunicipalityRow;
  profile: AdvertiserProfileRow;
  credential: SiteCredentialRow;
  design: DesignRow;
  window: {
    id: string;
    municipality_id: string;
    opens_at: string;
    closes_at: string;
    target_period_start: string;
    target_period_end: string;
  };
  boardPrefs: SubmissionInput["boardPreferences"];
}

async function loadJobContext(
  job: SubmissionJobRow,
): Promise<JobContext | { skip: true; code: SubmissionErrorCode; detail: string }> {
  const req = await loadRequest(job.request_id);
  if (!req) return { skip: true, code: "unknown", detail: "application_request not found" };
  if (!req.credential_id) return { skip: true, code: "login_failed", detail: "사이트 계정 미등록" };

  const [muni, profile, credential, design, window_] = await Promise.all([
    single<MunicipalityRow>("municipalities", req.municipality_id),
    single<AdvertiserProfileRow>("advertiser_profiles", req.profile_id),
    single<SiteCredentialRow>("site_credentials", req.credential_id),
    single<DesignRow>("designs", req.design_id),
    single<{
      id: string;
      municipality_id: string;
      opens_at: string;
      closes_at: string;
      target_period_start: string;
      target_period_end: string;
    }>("application_windows", job.window_id),
  ]);
  if (!muni || !profile || !credential || !design || !window_) {
    return { skip: true, code: "unknown", detail: "job context incomplete" };
  }

  const boardIds = req.board_preferences.map((b) => b.boardSiteId);
  const { data: boards } = await db()
    .from("board_sites")
    .select("id, external_id, name, municipality_id")
    .in("id", boardIds.length > 0 ? boardIds : ["00000000-0000-0000-0000-000000000000"]);
  const boardRows =
    (boards as Pick<BoardSiteRow, "id" | "external_id" | "name" | "municipality_id">[] | null) ?? [];
  const boardMap = new Map(boardRows.map((b) => [b.id, b]));

  // ── 테넌트·지자체 참조 무결성 재검증 (외부 사이트 접속 전 마지막 방어선) ──
  // DB 계층 제약이 1차 방어선이지만, 오염 데이터가 남아 있으면 Playwright/
  // 브라우저를 띄우기 전에 여기서 needs_manual 로 끝낸다.
  const integrity = checkJobContextIntegrity({
    job: { tenant_id: job.tenant_id, request_id: job.request_id, window_id: job.window_id },
    request: {
      id: req.id,
      tenant_id: req.tenant_id,
      municipality_id: req.municipality_id,
      profile_id: req.profile_id,
      design_id: req.design_id,
      credential_id: req.credential_id,
    },
    profile: { id: profile.id, tenant_id: profile.tenant_id },
    design: { id: design.id, tenant_id: design.tenant_id },
    credential: {
      id: credential.id,
      tenant_id: credential.tenant_id,
      municipality_id: credential.municipality_id,
    },
    window: { id: window_.id, municipality_id: window_.municipality_id },
    boardPrefIds: boardIds,
    boards: boardRows.map((b) => ({ id: b.id, municipality_id: b.municipality_id })),
  });
  if (!integrity.ok) {
    return { skip: true, code: "validation_rejected", detail: integrity.detail };
  }

  return {
    request: req,
    municipality: muni,
    profile,
    credential,
    design,
    window: window_,
    boardPrefs: req.board_preferences
      .filter((p) => boardMap.has(p.boardSiteId))
      .map((p) => ({
        ...p,
        externalId: boardMap.get(p.boardSiteId)!.external_id,
        boardName: boardMap.get(p.boardSiteId)!.name,
      })),
  };
}

async function single<T>(table: string, id: string): Promise<T | null> {
  const { data } = await db().from(table).select("*").eq("id", id).maybeSingle();
  return data as T | null;
}

async function loadJob(id: string): Promise<SubmissionJobRow | null> {
  return single<SubmissionJobRow>("submission_jobs", id);
}

async function loadRequest(id: string): Promise<ApplicationRequestRow | null> {
  return single<ApplicationRequestRow>("application_requests", id);
}

async function markJob(id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db().from("submission_jobs").update(patch).eq("id", id);
  if (error) {
    logger.error({ error, id, patch }, "job update failed");
    throw new Error(`submission job update failed: ${error.message}`);
  }
}

async function nextAttemptNo(jobId: string): Promise<number> {
  const { count } = await db()
    .from("submission_attempts")
    .select("id", { count: "exact", head: true })
    .eq("job_id", jobId);
  return (count ?? 0) + 1;
}

async function finishAttempt(
  attemptId: string,
  outcome: string,
  stepReached: string | undefined,
  screenshots: string[],
  auditEvents: readonly AuditEvidence[],
  errorDetail?: string,
): Promise<void> {
  const { error } = await db()
    .from("submission_attempts")
    .update({
      ended_at: new Date().toISOString(),
      outcome,
      step_reached: stepReached ?? null,
      screenshots,
      audit_events: auditEvents,
      error_detail: errorDetail ?? null,
    })
    .eq("id", attemptId);
  if (error) {
    logger.error({ error, attemptId, outcome }, "submission attempt update failed");
    throw new Error(`submission attempt update failed: ${error.message}`);
  }
}

async function isWindowOpen(windowId: string): Promise<boolean> {
  const { data } = await db()
    .from("application_windows")
    .select("closes_at")
    .eq("id", windowId)
    .maybeSingle();
  return data ? new Date(data.closes_at).getTime() > Date.now() : false;
}

async function notify(
  tenantId: string,
  type: string,
  refId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db()
    .from("notifications")
    .upsert(
      { tenant_id: tenantId, channel: "email", type, ref_id: refId, payload },
      { onConflict: "type,ref_id,channel,user_id", ignoreDuplicates: true },
    );
}
