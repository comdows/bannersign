import { createSupabaseServer, currentTenantId } from "@/lib/supabase/server";
import { CredentialForm, ProfileForm, TenantForm } from "./ui";

export default async function SettingsPage() {
  const tenantId = await currentTenantId();
  const supabase = await createSupabaseServer();

  if (!tenantId) {
    return (
      <>
        <h1>시작하기</h1>
        <div className="card">
          <h3>워크스페이스 생성</h3>
          <p style={{ fontSize: 14, color: "#555" }}>
            회사(또는 개인) 워크스페이스를 만들면 사업자 정보·시안·자동 신청을 관리할 수 있습니다.
          </p>
          <TenantForm />
        </div>
      </>
    );
  }

  const [{ data: profiles }, { data: credentials }, { data: municipalities }] = await Promise.all([
    supabase.from("advertiser_profiles").select("*").order("created_at"),
    supabase.from("site_credentials").select("*, municipalities(name)").order("created_at"),
    supabase.from("municipalities").select("id, name").order("name"),
  ]);

  return (
    <>
      <h1>설정</h1>

      <div className="card">
        <h3>사업자 프로필</h3>
        <table className="list">
          <tbody>
            {(profiles ?? []).map((p) => (
              <tr key={p.id}>
                <td>{p.business_name}</td>
                <td>{p.phone}</td>
                <td>{p.biz_reg_no ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ProfileForm />
      </div>

      <div className="card">
        <h3>지자체 사이트 계정</h3>
        <p style={{ fontSize: 13, color: "#555" }}>
          자동 제출은 회원님 본인 계정으로 진행됩니다. 비밀번호는 암호화되어 저장되며 제출 직전에만 사용됩니다.
        </p>
        <table className="list">
          <tbody>
            {(credentials ?? []).map((c) => (
              <tr key={c.id}>
                <td>{(c.municipalities as unknown as { name: string } | null)?.name}</td>
                <td>{c.username}</td>
                <td>
                  <span className={`badge ${c.status === "invalid" ? "fail" : ""}`}>{c.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <CredentialForm municipalities={municipalities ?? []} />
      </div>
    </>
  );
}
