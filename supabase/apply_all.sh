#!/usr/bin/env bash
# Supabase(또는 임의 Postgres)에 스키마+시드를 순서대로 적용한다.
#
# 사용법:
#   export DATABASE_URL="postgresql://postgres:<PW>@db.<ref>.supabase.co:5432/postgres"
#   ./supabase/apply_all.sh
#
# Supabase 대시보드 → Project Settings → Database → Connection string(URI)에서 복사.
# psql이 없으면 각 .sql을 SQL 에디터에 아래 순서로 붙여넣어 실행해도 된다.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
: "${DATABASE_URL:?DATABASE_URL 환경변수를 설정하세요}"

FILES=(
  "migrations/0001_init.sql"   # 스키마 + RLS + Storage 버킷/정책 + create_tenant_with_owner RPC
  "migrations/0002_tenant_reference_integrity.sql"  # 테넌트·지자체 참조 무결성(복합 FK/트리거/보안 RPC)
  "migrations/0003_request_readiness.sql"           # 자동 신청 준비도 게이트(트리거/RPC/once 만료)
  "migrations/0004_window_schedule_identity.sql"    # 창구 논리 식별자 unique(muni, target_period_start)
  "migrations/0005_credential_precheck.sql"         # D-1 계정 사전 점검 기록 unique(window, credential)
  "migrations/0006_s05_dry_run_rehearsal.sql"       # S05 1회 dry-run 요청/완료 상태/구조화 감사 증적
  "seed.sql"                   # 화성/오산/시흥 municipalities + specs
  "seed_boards_hwaseong.sql"   # 화성 게시대 197곳
  "seed_directory.sql"         # 어댑터 미구현 지자체 디렉토리(disabled)
)

for f in "${FILES[@]}"; do
  echo "==> applying $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$DIR/$f"
done

echo "완료. 다음: Storage 버킷(designs/audit/captcha)은 마이그레이션에서 생성되지만,"
echo "생성 실패 시 대시보드 Storage에서 private 버킷 3개를 수동 생성하세요."
