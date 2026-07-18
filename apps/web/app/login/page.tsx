"use client";

import { useState } from "react";
import { createSupabaseBrowser } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const supabase = createSupabaseBrowser();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/dashboard` },
    });
    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <main className="container">
      <h1>유니 로그인</h1>
      {sent ? (
        <p>로그인 링크를 이메일로 보냈습니다. 메일함을 확인하세요.</p>
      ) : (
        <form className="stack" onSubmit={sendMagicLink}>
          <input
            type="email"
            required
            placeholder="이메일 주소"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button type="submit">로그인 링크 받기</button>
          {error && <p style={{ color: "crimson" }}>{error}</p>}
        </form>
      )}
    </main>
  );
}
