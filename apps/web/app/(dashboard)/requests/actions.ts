"use server";

import {
  checkRequestReadiness,
  unwrapQuery,
  type ReadinessInput,
  type ReadinessResult,
} from "@youni/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createSupabaseServer, currentTenantId } from "@/lib/supabase/server";

export interface RequestActionResult {
  ok: boolean;
  message: string;
  /** 준비 부족으로 막힌 경우 전체 체크리스트 */
  readiness?: ReadinessResult;
}

/** 폼/클라이언트가 넘기는 선택값 — 형식·UUID 검증 */
const selectionSchema = z.object({
  municipalityId: z.string().uuid("지자체를 선택하세요."),
  profileId: z.string().uuid("사업자 프로필을 선택하세요."),
  credentialId: z.string().uuid().nullable(),
  designId: z.string().uuid("시안을 선택하세요."),
  boardIds: z.array(z.string().uuid()),
  recurrence: z.enum(["once", "monthly"]),
  dryRunOnly: z.boolean().default(false),
});
export type RequestSelection = z.infer<typeof selectionSchema>;

/** 빈 문자열·중복 정리 후 스키마 파싱 */
function parseSelection(raw: {
  municipalityId: string;
  profileId: string;
  credentialId: string | null;
  designId: string;
  boardIds: string[];
  recurrence: string;
  dryRunOnly?: boolean;
}): { ok: true; value: RequestSelection } | { ok: false; message: string } {
  const parsed = selectionSchema.safeParse({
    municipalityId: raw.municipalityId,
    profileId: raw.profileId,
    credentialId: raw.credentialId && raw.credentialId.length > 0 ? raw.credentialId : null,
    designId: raw.designId,
    boardIds: Array.from(new Set(raw.boardIds.filter(Boolean))),
    recurrence: raw.dryRunOnly ? "once" : raw.recurrence === "once" ? "once" : "monthly",
    dryRunOnly: raw.dryRunOnly ?? false,
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "입력값이 올바르지 않습니다." };
  }
  return { ok: true, value: parsed.data };
}

/** DB 에서 준비도 스냅샷을 로드해 순수 판정기로 평가 (RLS 경유 — 본인 데이터만) */
async function loadReadiness(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  tenantId: string,
  sel: RequestSelection,
): Promise<ReadinessResult> {
  const [muniRes, credRes, profRes, specRes, boardsRes] = await Promise.all([
    supabase.from("municipalities").select("status, capabilities").eq("id", sel.municipalityId).maybeSingle(),
    sel.credentialId
      ? supabase
          .from("site_credentials")
          .select("tenant_id, municipality_id, status")
          .eq("id", sel.credentialId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase.from("advertiser_profiles").select("business_name, phone").eq("id", sel.profileId).maybeSingle(),
    supabase
      .from("municipality_specs")
      .select("version")
      .eq("municipality_id", sel.municipalityId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle(),
    sel.boardIds.length > 0
      ? supabase.from("board_sites").select("id, municipality_id, is_active").in("id", sel.boardIds)
      : Promise.resolve({ data: [] as { id: string; municipality_id: string; is_active: boolean }[], error: null }),
  ]);

  // 조회 오류를 "행 없음(정상 미충족)"으로 삼키지 않는다 — 오류면 throw 하고
  // 상위(server action)가 안전한 실패/non-ready 로 변환한다(SQL 상세는 비노출).
  const m = unwrapQuery(muniRes, "municipalities") as {
    status: string;
    capabilities: { autoSubmit: boolean };
  } | null;
  const c = unwrapQuery(credRes, "site_credentials") as {
    tenant_id: string;
    municipality_id: string;
    status: string;
  } | null;
  const p = unwrapQuery(profRes, "advertiser_profiles") as { business_name: string; phone: string } | null;
  const latestSpecVersion =
    (unwrapQuery(specRes, "municipality_specs") as { version: number } | null)?.version ?? null;
  const boards = unwrapQuery(boardsRes, "board_sites") as
    | { id: string; municipality_id: string; is_active: boolean }[]
    | null;

  let designValidation: ReadinessInput["designValidation"] = null;
  if (latestSpecVersion !== null) {
    const dvRes = await supabase
      .from("design_validations")
      .select("verdict, spec_version")
      .eq("design_id", sel.designId)
      .eq("municipality_id", sel.municipalityId)
      .eq("spec_version", latestSpecVersion)
      .maybeSingle();
    const row = unwrapQuery(dvRes, "design_validations") as {
      verdict: "pass" | "warn" | "fail";
      spec_version: number;
    } | null;
    if (row) designValidation = { verdict: row.verdict, specVersion: row.spec_version };
  }

  const input: ReadinessInput = {
    tenantId,
    municipalityId: sel.municipalityId,
    municipality: m ? { status: m.status, capabilities: m.capabilities } : null,
    credentialId: sel.credentialId,
    credential: c ? { tenant_id: c.tenant_id, municipality_id: c.municipality_id, status: c.status } : null,
    profile: p ? { business_name: p.business_name, phone: p.phone } : null,
    latestSpecVersion,
    designValidation,
    selectedBoardIds: sel.boardIds,
    boards: boards ?? [],
  };
  return checkRequestReadiness(input, sel.dryRunOnly ? "dry_run" : "live");
}

/** 폼 선택값에 대한 준비도 평가 (RequestForm 이 선택 변경마다 호출) */
export async function evaluateRequestReadiness(raw: {
  municipalityId: string;
  profileId: string;
  credentialId: string | null;
  designId: string;
  boardIds: string[];
  recurrence: string;
  dryRunOnly: boolean;
}): Promise<ReadinessResult> {
  const tenantId = await currentTenantId();
  if (!tenantId) {
    return {
      ready: false,
      issues: [{ code: "profile_incomplete", messageKo: "로그인/워크스페이스가 필요합니다.", resolution: { label: "설정", href: "/settings" } }],
    };
  }
  const parsed = parseSelection(raw);
  if (!parsed.ok) {
    return { ready: false, issues: [{ code: "profile_incomplete", messageKo: parsed.message }] };
  }
  const supabase = await createSupabaseServer();
  try {
    return await loadReadiness(supabase, tenantId, parsed.value);
  } catch (err) {
    // 조회 오류 → 안전한 non-ready. SQL 상세는 서버 로그에만 남기고 클라이언트엔
    // 노출하지 않는다. ready 가 아니므로 폼 제출 버튼은 비활성 유지된다(fail-closed).
    console.error("[evaluateRequestReadiness] readiness lookup failed", err);
    return {
      ready: false,
      issues: [{ code: "profile_incomplete", messageKo: "준비도를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요." }],
    };
  }
}

/** 상시 주문(standing order) 등록 — 준비된 경우에만 DB 권위 경로로 생성 */
export async function createRequest(formData: FormData): Promise<RequestActionResult> {
  const tenantId = await currentTenantId();
  if (!tenantId) return { ok: false, message: "테넌트가 없습니다." };

  const parsed = parseSelection({
    municipalityId: String(formData.get("municipality_id") ?? ""),
    profileId: String(formData.get("profile_id") ?? ""),
    credentialId: String(formData.get("credential_id") ?? "") || null,
    designId: String(formData.get("design_id") ?? ""),
    boardIds: formData.getAll("board_ids").map(String),
    recurrence: String(formData.get("recurrence") ?? "monthly"),
    dryRunOnly: String(formData.get("dry_run_only") ?? "") === "true",
  });
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const sel = parsed.value;

  const supabase = await createSupabaseServer();

  // 사용자 친화적 체크리스트 (DB 트리거가 최종 권위지만, 여기서 전체 이슈를 모아 보여준다)
  let readiness: ReadinessResult;
  try {
    readiness = await loadReadiness(supabase, tenantId, sel);
  } catch (err) {
    // 조회 오류 → SQL 상세 비노출, fail-closed(생성 안 함).
    console.error("[createRequest] readiness lookup failed", err);
    return { ok: false, message: "준비도를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요." };
  }
  if (!readiness.ready) {
    return {
      ok: false,
      message: readiness.issues[0]?.messageKo ?? "자동 신청 준비가 완료되지 않았습니다.",
      readiness,
    };
  }

  // DB 권위 경로: create_application_request RPC (멤버십·참조무결성·준비도 최종 검증)
  const { error } = await supabase.rpc("create_application_request", {
    p_tenant_id: tenantId,
    p_municipality_id: sel.municipalityId,
    p_profile_id: sel.profileId,
    p_design_id: sel.designId,
    p_credential_id: sel.credentialId,
    p_board_preferences: sel.boardIds.map((id, i) => ({ boardSiteId: id, priority: i + 1 })),
    p_recurrence: sel.recurrence,
    p_dry_run_only: sel.dryRunOnly,
  });
  if (error) {
    // DB 가 준비도로 막았다면(레이스 등) 최신 체크리스트를 다시 실어 보낸다.
    // recheck 조회가 실패하면 체크리스트 없이 친화적 오류만 반환한다(SQL 비노출).
    let recheck: ReadinessResult | undefined;
    try {
      const r = await loadReadiness(supabase, tenantId, sel);
      recheck = r.ready ? undefined : r;
    } catch (err) {
      console.error("[createRequest] readiness recheck failed", err);
    }
    return { ok: false, message: friendlyRequestError(error.message), readiness: recheck };
  }

  revalidatePath("/requests");
  return {
    ok: true,
    message: sel.dryRunOnly
      ? "1회 리허설이 예약되었습니다. 창구가 열려 있으면 다음 worker 실행에서 시작됩니다."
      : "자동 신청이 등록되었습니다. 다음 접수 기간에 자동으로 제출됩니다.",
  };
}

/**
 * RPC/DB 오류 메시지를 사용자에게 안전하게 노출한다.
 * create_application_request 는 위반을 한국어 메시지로 변환해 raise 하므로
 * 한글이 포함된 메시지는 그대로 보여주고, 그 밖의(내부 SQL 등) 메시지는
 * 세부정보를 감춘 일반 안내로 대체한다.
 */
function friendlyRequestError(message: string): string {
  if (/[가-힣]/.test(message)) return message;
  return "자동 신청을 등록할 수 없습니다. 입력값을 확인해 주세요.";
}

export async function toggleRequest(id: string, status: "active" | "paused"): Promise<void> {
  const supabase = await createSupabaseServer();
  // active 로 전이 시 DB 준비도 트리거가 검증한다(준비 부족이면 update 가 거부됨).
  await supabase.from("application_requests").update({ status }).eq("id", id);
  revalidatePath("/requests");
}
