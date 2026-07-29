import { createSupabaseServer } from "@/lib/supabase/server";
import { BoardsExplorer } from "./ui";

/** 지역 게시대 지도 — 지자체별 게시대 위치·요금·규격 탐색 (읽기 전용) */
export default async function BoardsPage() {
  const supabase = await createSupabaseServer();
  const [{ data: municipalities }, { data: boards }] = await Promise.all([
    supabase.from("municipalities").select("id, name, status").order("name"),
    supabase
      .from("board_sites")
      .select("id, municipality_id, name, lat, lng, address, fee, slot_count, dimensions_cm, raw")
      .eq("is_active", true)
      .order("name"),
  ]);

  return (
    <>
      <h1>지역 게시대 지도</h1>
      <p style={{ fontSize: 14, color: "#555" }}>
        지자체별 현수막 게시대가 어디에 있는지 확인하세요. 신청은{" "}
        <a href="/requests">자동 신청 등록</a>에서 지도로 게시대를 선택하면 됩니다.
      </p>
      <BoardsExplorer
        municipalities={municipalities ?? []}
        boards={(boards ?? []) as never}
        kakaoAppKey={process.env.NEXT_PUBLIC_KAKAO_MAP_APP_KEY}
      />
    </>
  );
}
