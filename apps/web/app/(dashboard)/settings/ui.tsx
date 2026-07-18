"use client";

import { useState, useTransition } from "react";
import { createCredential, createProfile, createTenant } from "./actions";
import type { ActionResult } from "../designs/actions";

function useAction(action: (fd: FormData) => Promise<ActionResult>) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const run = (fd: FormData) =>
    startTransition(async () => {
      const res = await action(fd);
      setMessage(res.message);
    });
  return { pending, message, run };
}

export function TenantForm() {
  const { pending, message, run } = useAction(createTenant);
  return (
    <form className="stack" action={run}>
      <input name="name" placeholder="회사/워크스페이스 이름" required />
      <button disabled={pending}>{pending ? "생성 중..." : "생성"}</button>
      {message && <p style={{ fontSize: 13 }}>{message}</p>}
    </form>
  );
}

export function ProfileForm() {
  const { pending, message, run } = useAction(createProfile);
  return (
    <form className="stack" action={run}>
      <input name="business_name" placeholder="상호(사업자명)" required />
      <input name="biz_reg_no" placeholder="사업자등록번호 (선택)" />
      <input name="representative" placeholder="대표자명 (선택)" />
      <input name="phone" placeholder="연락처" required />
      <input name="email" type="email" placeholder="이메일 (선택)" />
      <input name="address" placeholder="주소 (선택)" />
      <button disabled={pending}>{pending ? "저장 중..." : "프로필 추가"}</button>
      {message && <p style={{ fontSize: 13 }}>{message}</p>}
    </form>
  );
}

export function CredentialForm({ municipalities }: { municipalities: { id: string; name: string }[] }) {
  const { pending, message, run } = useAction(createCredential);
  return (
    <form className="stack" action={run}>
      <select name="municipality_id" required>
        {municipalities.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      <input name="username" placeholder="사이트 아이디" required autoComplete="off" />
      <input name="password" type="password" placeholder="사이트 비밀번호" required autoComplete="new-password" />
      <button disabled={pending}>{pending ? "등록 중..." : "계정 등록"}</button>
      {message && <p style={{ fontSize: 13 }}>{message}</p>}
    </form>
  );
}
