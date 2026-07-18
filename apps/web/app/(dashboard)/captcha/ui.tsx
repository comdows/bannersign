"use client";

import { useState, useTransition } from "react";
import { answerCaptcha } from "./actions";

export function CaptchaAnswerForm({ relayId }: { relayId: string }) {
  const [pending, startTransition] = useTransition();
  const [answer, setAnswer] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <input
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder="캡차 답 입력"
        autoFocus
      />
      <button
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const res = await answerCaptcha(relayId, answer);
            setMessage(res.message);
          })
        }
      >
        {pending ? "전송 중..." : "전송"}
      </button>
      {message && <span style={{ fontSize: 13 }}>{message}</span>}
    </div>
  );
}
