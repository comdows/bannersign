"use server";

import { randomUUID } from "node:crypto";
import { validateDesign } from "@youni/ai";
import type { DesignSpec } from "@youni/core";
import { imageSize } from "image-size";
import { revalidatePath } from "next/cache";
import { createSupabaseServer, currentTenantId } from "@/lib/supabase/server";

export interface ActionResult {
  ok: boolean;
  message: string;
}

/** 시안 업로드 → Storage 저장 → designs 레코드 생성 */
export async function uploadDesign(formData: FormData): Promise<ActionResult> {
  const tenantId = await currentTenantId();
  if (!tenantId) return { ok: false, message: "테넌트가 없습니다. 온보딩을 먼저 완료하세요." };

  const file = formData.get("file") as File | null;
  if (!file) return { ok: false, message: "파일이 없습니다." };
  if (file.size > 10 * 1024 * 1024) return { ok: false, message: "10MB 이하 파일만 가능합니다." };

  const buf = Buffer.from(await file.arrayBuffer());
  let dims: { width?: number; height?: number };
  try {
    dims = imageSize(buf);
  } catch {
    return { ok: false, message: "이미지 파일이 아니거나 해석할 수 없습니다." };
  }

  const supabase = await createSupabaseServer();
  const storagePath = `${tenantId}/${randomUUID()}-${file.name}`;
  const { error: upErr } = await supabase.storage.from("designs").upload(storagePath, buf, {
    contentType: file.type,
  });
  if (upErr) return { ok: false, message: `업로드 실패: ${upErr.message}` };

  const { error } = await supabase.from("designs").insert({
    tenant_id: tenantId,
    storage_path: storagePath,
    file_name: file.name,
    file_meta: { widthPx: dims.width, heightPx: dims.height, sizeBytes: file.size },
  });
  if (error) return { ok: false, message: error.message };

  revalidatePath("/designs");
  return { ok: true, message: "시안이 업로드되었습니다." };
}

/** 선택한 지자체 규격으로 AI 검증 실행 */
export async function runValidation(designId: string, municipalityId: string): Promise<ActionResult> {
  const tenantId = await currentTenantId();
  if (!tenantId) return { ok: false, message: "로그인이 필요합니다." };

  const supabase = await createSupabaseServer();
  const [{ data: design }, { data: muni }, { data: spec }] = await Promise.all([
    supabase.from("designs").select("*").eq("id", designId).single(),
    supabase.from("municipalities").select("id, name").eq("id", municipalityId).single(),
    supabase
      .from("municipality_specs")
      .select("version, spec")
      .eq("municipality_id", municipalityId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (!design || !muni || !spec) return { ok: false, message: "시안/지자체/규격을 찾을 수 없습니다." };

  // 캐시: 동일 design × municipality × spec_version이면 재호출 안 함
  const { data: cached } = await supabase
    .from("design_validations")
    .select("id")
    .eq("design_id", designId)
    .eq("municipality_id", municipalityId)
    .eq("spec_version", spec.version)
    .maybeSingle();
  if (cached) return { ok: true, message: "이미 검증된 조합입니다 (규격 변경 시 재검증)." };

  const { data: file, error: dlErr } = await supabase.storage
    .from("designs")
    .download(design.storage_path);
  if (dlErr || !file) return { ok: false, message: "시안 파일을 불러올 수 없습니다." };

  const ext = design.file_name.split(".").pop()?.toLowerCase();
  const result = await validateDesign(
    {
      base64: Buffer.from(await file.arrayBuffer()).toString("base64"),
      mediaType: ext === "png" ? "image/png" : "image/jpeg",
      fileName: design.file_name,
      widthPx: design.file_meta?.widthPx ?? 0,
      heightPx: design.file_meta?.heightPx ?? 1,
    },
    spec.spec as DesignSpec,
    muni.name,
  );

  const { error } = await supabase.from("design_validations").insert({
    design_id: designId,
    tenant_id: tenantId,
    municipality_id: municipalityId,
    spec_version: spec.version,
    verdict: result.verdict,
    findings: result.findings,
    model: result.model,
  });
  if (error) return { ok: false, message: error.message };

  revalidatePath("/designs");
  return { ok: true, message: `검증 완료: ${result.verdict}` };
}
