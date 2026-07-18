"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServer, currentTenantId } from "@/lib/supabase/server";
import type { ActionResult } from "../designs/actions";

/** 상시 주문(standing order) 등록 — 창구가 열리면 worker가 자동 신청 */
export async function createRequest(formData: FormData): Promise<ActionResult> {
  const tenantId = await currentTenantId();
  if (!tenantId) return { ok: false, message: "테넌트가 없습니다." };

  const municipalityId = String(formData.get("municipality_id") ?? "");
  const profileId = String(formData.get("profile_id") ?? "");
  const credentialId = String(formData.get("credential_id") ?? "");
  const designId = String(formData.get("design_id") ?? "");
  const boardIds = formData.getAll("board_ids").map(String).filter(Boolean);

  if (!municipalityId || !profileId || !designId) {
    return { ok: false, message: "지자체/프로필/시안은 필수입니다." };
  }

  const supabase = await createSupabaseServer();
  const { error } = await supabase.from("application_requests").insert({
    tenant_id: tenantId,
    municipality_id: municipalityId,
    profile_id: profileId,
    credential_id: credentialId || null,
    design_id: designId,
    board_preferences: boardIds.map((id, i) => ({ boardSiteId: id, priority: i + 1 })),
    recurrence: String(formData.get("recurrence") ?? "monthly"),
  });
  if (error) return { ok: false, message: error.message };

  revalidatePath("/requests");
  return { ok: true, message: "자동 신청이 등록되었습니다. 다음 접수 기간에 자동으로 제출됩니다." };
}

export async function toggleRequest(id: string, status: "active" | "paused"): Promise<void> {
  const supabase = await createSupabaseServer();
  await supabase.from("application_requests").update({ status }).eq("id", id);
  revalidatePath("/requests");
}
