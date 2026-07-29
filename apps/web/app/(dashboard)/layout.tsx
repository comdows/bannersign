import Link from "next/link";
import type { ReactNode } from "react";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <nav className="topnav">
        <span className="brand">유니</span>
        <Link href="/dashboard">신청 현황</Link>
        <Link href="/boards">게시대 지도</Link>
        <Link href="/designs">시안</Link>
        <Link href="/requests">자동 신청 등록</Link>
        <Link href="/captcha">캡차 대기</Link>
        <Link href="/settings">설정</Link>
      </nav>
      <main className="container">{children}</main>
    </>
  );
}
