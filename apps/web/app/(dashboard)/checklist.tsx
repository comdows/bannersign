import Link from "next/link";
import type { OnboardingState } from "@/lib/onboarding";

interface Step {
  label: string;
  done: boolean;
  href: string;
  hint: string;
}

/** 온보딩 체크리스트 — 완료 전까지 대시보드 상단에 노출. 완료되면 렌더 안 함. */
export function OnboardingChecklist({ state }: { state: OnboardingState }) {
  if (state.complete) return null;

  const steps: Step[] = [
    {
      label: "워크스페이스 만들기",
      done: Boolean(state.tenantId),
      href: "/settings",
      hint: "회사(또는 개인) 작업 공간",
    },
    {
      label: "사업자 프로필 등록",
      done: state.hasProfile,
      href: "/settings",
      hint: "현수막에 표기될 사업자 정보",
    },
    {
      label: "지자체 사이트 계정 등록",
      done: state.hasCredential,
      href: "/settings",
      hint: "예: 화성 hsdr.or.kr 회원 계정 — 암호화 저장",
    },
    {
      label: "시안 업로드 + AI 검증",
      done: state.hasDesign,
      href: "/designs",
      hint: "JPG 시안을 올리고 지자체 규격 검사",
    },
    {
      label: "자동 신청 등록",
      done: state.hasRequest,
      href: "/requests",
      hint: "창구가 열리면 자동으로 제출됩니다",
    },
  ];
  const next = steps.find((s) => !s.done);

  return (
    <div className="card" style={{ borderLeft: "4px solid #2c6ecb" }}>
      <h3>시작하기 — {steps.filter((s) => s.done).length}/{steps.length} 완료</h3>
      <ol style={{ margin: "8px 0 0", paddingLeft: 20, fontSize: 14, lineHeight: 1.9 }}>
        {steps.map((s) => (
          <li key={s.label} style={{ opacity: s.done ? 0.55 : 1 }}>
            {s.done ? "✅ " : s === next ? "👉 " : "⬜ "}
            {s.done ? (
              s.label
            ) : (
              <Link href={s.href}>{s.label}</Link>
            )}{" "}
            <span style={{ color: "#777", fontSize: 12 }}>— {s.hint}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
