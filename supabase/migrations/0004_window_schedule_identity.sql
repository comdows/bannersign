-- youni: 창구 논리 식별자 고정 — (municipality_id, target_period_start) (S03)
-- ---------------------------------------------------------------------------
-- 목적:
--   논리적 창구 식별자는 (municipality_id, target_period_start) 다. 같은 지자체·
--   대상 게시기간에 rule/crawled(또는 manual) 이중 행이 생기면 규칙 일정과 실측
--   일정을 reconcile 할 수 없다. 이 마이그레이션은 그 논리 키에 unique 를 걸어
--   이중 행을 원천 차단한다.
--
--   0001 의 unique(municipality_id, opens_at) 는 그대로 둔다(오픈 시각 중복 방지).
--   이 키와 별개로, 같은 target_period_start 에 opens_at 만 다른 이중 행을 막는 게
--   이 마이그레이션의 핵심이다.
--
-- ---------------------------------------------------------------------------
-- 사전검사 / 롤백 위험:
--   * HARD-FAIL 사전검사: 이미 같은 (municipality_id, target_period_start) 논리 키에
--     2건 이상인 그룹이 있으면 EXCEPTION 으로 전체 롤백한다. constraint 를 붙이다
--     나오는 모호한 오류 대신, 어떤 논리 키가 몇 그룹 중복인지와 교정 조회를 안내.
--   * FORWARD-FIX: 중복이면 출처 우선순위(manual > crawled > rule)에 따라 남길
--     행을 정하고 나머지를 삭제하거나 target_period_start 를 교정한 뒤 재적용한다.
--       select municipality_id, target_period_start, count(*),
--              array_agg(id order by (source='manual') desc, (source='crawled') desc, created_at)
--       from application_windows group by 1,2 having count(*) > 1;
--   * 롤백: down 스크립트 없음. 되돌리려면 아래 constraint 를 DROP 하면 되며
--     데이터 손실 없음(구조 변경만).
-- ---------------------------------------------------------------------------

do $$
declare
  v_dup_groups int;
begin
  select count(*) into v_dup_groups
  from (
    select municipality_id, target_period_start
    from application_windows
    group by municipality_id, target_period_start
    having count(*) > 1
  ) d;

  if v_dup_groups > 0 then
    raise exception
      '[precheck] 같은 (municipality_id, target_period_start) 논리 키 중복 % 그룹. 교정: select municipality_id, target_period_start, count(*), array_agg(id order by (source=''manual'') desc, (source=''crawled'') desc, created_at) from application_windows group by 1,2 having count(*)>1; 우선순위(manual>crawled>rule)로 하나만 남기고 정리 후 재적용.',
      v_dup_groups;
  end if;

  raise notice '[precheck] 논리 키 중복 없음 — unique constraint 를 추가한다.';
end $$;

alter table application_windows
  add constraint application_windows_muni_target_key
  unique (municipality_id, target_period_start);
