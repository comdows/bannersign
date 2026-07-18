import { createSupabaseServer } from "@/lib/supabase/server";
import { CaptchaAnswerForm } from "./ui";

export const dynamic = "force-dynamic";

export default async function CaptchaPage() {
  const supabase = await createSupabaseServer();
  const { data: relays } = await supabase
    .from("captcha_relays")
    .select("id, image_path, requested_at, expires_at, status")
    .eq("status", "waiting")
    .gt("expires_at", new Date().toISOString())
    .order("requested_at");

  const withUrls = await Promise.all(
    (relays ?? []).map(async (r) => {
      const { data } = await supabase.storage.from("captcha").createSignedUrl(r.image_path, 600);
      return { ...r, imageUrl: data?.signedUrl ?? null };
    }),
  );

  return (
    <>
      <h1>캡차 입력 대기</h1>
      <p style={{ fontSize: 14, color: "#555" }}>
        자동 제출 중 캡차를 만나면 여기에 표시됩니다. 제한 시간 내에 입력하면 제출이 계속됩니다.
      </p>
      {withUrls.length === 0 && (
        <div className="card">현재 대기 중인 캡차가 없습니다.</div>
      )}
      {withUrls.map((r) => (
        <div className="card" key={r.id}>
          {r.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={r.imageUrl} alt="캡차 이미지" style={{ maxWidth: 240, display: "block", marginBottom: 8 }} />
          )}
          <p style={{ fontSize: 13, color: "#777" }}>
            만료: {new Date(r.expires_at).toLocaleTimeString("ko-KR")}
          </p>
          <CaptchaAnswerForm relayId={r.id} />
        </div>
      ))}
    </>
  );
}
