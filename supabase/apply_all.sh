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
