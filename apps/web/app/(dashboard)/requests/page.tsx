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
    supabase.from("board_sites").select("id, municipality_id, name").eq("is_active", true),
  ]);

  return (
    <>
      <h1>자동 신청 등록</h1>
      <div className="card">
        <RequestForm
          municipalities={municipalities ?? []}
          profiles={profiles ?? []}
          credentials={credentials ?? []}
          designs={designs ?? []}
          boards={boards ?? []}
        />
      </div>

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
