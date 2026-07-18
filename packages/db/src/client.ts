import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type Db = SupabaseClient;

export interface SupabaseEnv {
  url: string;
  anonKey?: string;
  serviceRoleKey?: string;
}

export function readSupabaseEnv(): SupabaseEnv {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is not set");
  return {
    url,
    anonKey: process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

/**
 * worker 전용 — RLS 우회(service_role). 웹 클라이언트/브라우저에 절대 노출 금지.
 */
export function createServiceClient(env: SupabaseEnv = readSupabaseEnv()): Db {
  if (!env.serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * 익명(anon key) 클라이언트 — 사용자 세션 토큰과 함께 RLS 경유 접근.
 * Next.js 서버 컴포넌트/액션에서는 @supabase/ssr 기반 팩토리(apps/web)를 사용한다.
 */
export function createAnonClient(env: SupabaseEnv = readSupabaseEnv()): Db {
  if (!env.anonKey) throw new Error("SUPABASE_ANON_KEY is not set");
  return createClient(env.url, env.anonKey, {
    auth: { persistSession: false },
  });
}
