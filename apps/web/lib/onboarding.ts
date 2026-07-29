import { createSupabaseServer, currentTenantId } from "@/lib/supabase/server";

export interface OnboardingState {
  tenantId: string | null;
  hasProfile: boolean;
  hasCredential: boolean;
  hasDesign: boolean;
  hasRequest: boolean;
  /** 5단계 모두 완료 */
  complete: boolean;
}

/** 온보딩 진행 상태 — 대시보드 체크리스트와 각 페이지의 선행 조건 안내에 사용 */
export async function getOnboardingState(): Promise<OnboardingState> {
  const tenantId = await currentTenantId();
  if (!tenantId) {
    return {
      tenantId: null,
      hasProfile: false,
      hasCredential: false,
      hasDesign: false,
      hasRequest: false,
      complete: false,
    };
  }

  const supabase = await createSupabaseServer();
  const count = async (table: string) => {
    const { count: c } = await supabase.from(table).select("id", { count: "exact", head: true });
    return (c ?? 0) > 0;
  };
  const [hasProfile, hasCredential, hasDesign, hasRequest] = await Promise.all([
    count("advertiser_profiles"),
    count("site_credentials"),
    count("designs"),
    count("application_requests"),
  ]);

  return {
    tenantId,
    hasProfile,
    hasCredential,
    hasDesign,
    hasRequest,
    complete: hasProfile && hasCredential && hasDesign && hasRequest,
  };
}
