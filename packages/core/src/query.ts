/**
 * PostgREST(supabase-js) 조회 결과를 fail-closed 로 다루기 위한 순수 헬퍼 (S02R).
 *
 * supabase-js 는 조회 실패 시 예외를 던지지 않고 { data: null, error } 를 돌려준다.
 * 이 결과의 data 만 보고 판단하면 "조회 오류"가 "행 없음(정상적인 미충족)"으로
 * 조용히 뒤바뀐다. readiness 게이트에서는 이 혼동이 치명적이다(운영 장애를
 * 사용자 데이터 미충족으로 오인 → 잘못된 skip). unwrapQuery 는 error 가 있으면
 * 명시적으로 throw 해서 호출자가 fail-closed(잡 미생성/서버액션 실패)로 처리하고
 * 오류 세부를 로그/상위 오류에 남기도록 강제한다.
 */

export interface PostgrestErrorLike {
  message?: string | null;
  code?: string | null;
  details?: string | null;
}

export interface QueryResultLike<T> {
  data: T;
  error: PostgrestErrorLike | null;
}

/**
 * res.error 가 있으면 context 를 포함한 Error 를 던지고, 없으면 res.data 를 반환한다.
 * context 는 어떤 조회였는지 식별하는 내부 문자열(예: `municipalities(<id>)`).
 * 반환된 메시지에는 SQL 상세가 담기므로 사용자에게 그대로 노출하지 말 것.
 */
export function unwrapQuery<T>(res: QueryResultLike<T>, context: string): T {
  if (res.error) {
    const parts = [res.error.code, res.error.message, res.error.details]
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .join(" ");
    throw new Error(`query failed [${context}]: ${parts || "unknown postgrest error"}`);
  }
  return res.data;
}
