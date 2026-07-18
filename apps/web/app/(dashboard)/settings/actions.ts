"use server";

import { encryptSecret, loadEncKey } from "@youni/core";
import { revalidatePath } from "next/cache";
import { createSupabaseServer, currentTenantId } from "@/lib/supabase/server";
import type { ActionResult } from "../designs/actions";

/** 온보딩: 테넌트 생성 + 본인을 owner로 등록 */
export async function createTenant(formData: FormData): Promise<ActionResult> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, message: "이름을 입력하세요." };

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "로그인이 필요합니다." };

  // RPC가 테넌트 + owner 멤버십을 한 트랜잭션으로 생성 (RLS 반환 제약 회피)
  const { error } = await supabase.rpc("create_tenant_with_owner", { p_name: name });
  if (error) return { ok: false, message: error.message };

  revalidatePath("/settings");
  return { ok: true, message: "워크스페이스가 생성되었습니다." };
}

export async function createProfile(formData: FormData): Promise<ActionResult> {
  const tenantId = await currentTenantId();
  if (!tenantId) return { ok: false, message: "워크스페이스를 먼저 생성하세요." };

  const supabase = await createSupabaseServer();
  const { error } = await supabase.from("advertiser_profiles").insert({
    tenant_id: tenantId,
    business_name: String(formData.get("business_name") ?? ""),
    biz_reg_no: String(formData.get("biz_reg_no") ?? "") || null,
    representative: String(formData.get("representative") ?? "") || null,
    phone: String(formData.get("phone") ?? ""),
    email: String(formData.get("email") ?? "") || null,
    address: String(formData.get("address") ?? "") || null,
  });
  if (error) return { ok: false, message: error.message };
  revalidatePath("/settings");
  return { ok: true, message: "사업자 프로필이 저장되었습니다." };
}

/** 지자체 사이트 계정 등록 — 비밀번호는 서버에서 AES-256-GCM 암호화 후 저장 */
export async function createCredential(formData: FormData): Promise<ActionResult> {
  const tenantId = await currentTenantId();
  if (!tenantId) return { ok: false, message: "워크스페이스를 먼저 생성하세요." };

  const municipalityId = String(formData.get("municipality_id") ?? "");
  const username = String(formData.get("username") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!municipalityId || !username || !password) {
    return { ok: false, message: "모든 항목을 입력하세요." };
  }

  const enc = encryptSecret(password, loadEncKey());

  const supabase = await createSupabaseServer();
  const { error } = await supabase.from("site_credentials").insert({
    tenant_id: tenantId,
    municipality_id: municipalityId,
    username,
    password_enc: enc.data,
    enc_iv: enc.iv,
  });
  if (error) return { ok: false, message: error.message };
  revalidatePath("/settings");
  return { ok: true, message: "사이트 계정이 등록되었습니다. 접수 전날 자동으로 로그인 점검됩니다." };
}
