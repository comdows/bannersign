import Link from "next/link";
import { createSupabaseServer } from "@/lib/supabase/server";
import { RequestForm } from "./ui";

export default async function RequestsPage() {
  const supabase = await createSupabaseServer();
  const [
    { data: requests },
    { data: municipalities },
    { data: profiles },
    { data: credentials },
    { data: designs },
    { data: boards },
  ] = await Promise.all([
    supabase
      .from("application_requests")
      .select("*, municipalities(name), advertiser_profiles(business_name), designs(file_name)")
      .order("created_at", { ascending: false }),
    supabase.from("municipalities").select("id, name, status").order("name"),
    supabase.from("advertiser_profiles").select("id, business_name"),
    supabase.from("site_credentials").select("id, municipality_id, username, status"),
    supabase.from("designs").select("id, file_name"),
    supabase
      .from("board_sites")
      .select("id, municipality_id, name, lat, lng, address, fee")
      .eq("is_active", true)
      .order("name"),
  ]);

  const missing: Array<{ label: string; href: string }> = [];
  if ((profiles ?? []).length === 0) missing.push({ label: "사업자 프로필 (설정)", href: "/settings" });
  if ((credentials ?? []).length === 0)
    missing.push({ label: "지자체 사이트 계정 (설정)", href: "/settings" });
  if ((designs ?? []).length === 0) missing.push({ label: "시안 업로드 (시안)", href: "/designs" });

  return (
    <>
      <h1>자동 신청 등록</h1>
      <p style={{ fontSize: 14, color: "#555" }}>
        한 번 등록해두면 매월 신청 창구가 열릴 때 자동으로 제출됩니다(추첨 당첨을 보장하지는
        않습니다). 진행 과정은 신청 현황의 타임라인에서 스크린샷으로 확인할 수 있습니다.
      </p>
      {missing.length > 0 ? (
        <div className="card" style={{ borderLeft: "4px solid #c9a227" }}>
          <h3>먼저 준비가 필요합니다</h3>
          <p style={{ fontSize: 14 }}>자동 신청을 등록하려면 아래 항목을 먼저 완료해 주세요:</p>
          <ul style={{ fontSize: 14, lineHeight: 1.9 }}>
            {missing.map((m) => (
              <li key={m.href + m.label}>
                <Link href={m.href}>{m.label}</Link>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="card">
          <RequestForm
            municipalities={municipalities ?? []}
            profiles={profiles ?? []}
            credentials={credentials ?? []}
            designs={designs ?? []}
            boards={boards ?? []}
            kakaoAppKey={process.env.NEXT_PUBLIC_KAKAO_MAP_APP_KEY}
          />
        </div>
      )}

      <div className="card">
        <h3>등록된 자동 신청</h3>
        <table className="list">
          <thead>
            <tr>
              <th>지자체</th>
              <th>사업자</th>
              <th>시안</th>
              <th>반복</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {(requests ?? []).map((r) => (
              <tr key={r.id}>
                <td>{(r.municipalities as unknown as { name: string } | null)?.name}</td>
                <td>{(r.advertiser_profiles as unknown as { business_name: string } | null)?.business_name}</td>
                <td>{(r.designs as unknown as { file_name: string } | null)?.file_name}</td>
                <td>{r.recurrence === "monthly" ? "매월" : "1회"}</td>
                <td>
                  <span className="badge">{r.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
