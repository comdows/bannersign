-- 초기 시드: 화성시 · 오산시 레지스트리
-- 게시대 목록과 정확한 규격/일정은 어댑터 크롤 또는 admin UI로 갱신한다.
-- 아래 규격/일정 값은 개발용 플레이스홀더 — 운영 반영 전 각 지자체 공고문 기준으로 검수할 것.

-- 운영 주체: 지자체가 직접 운영하지 않고 수탁 기관(화성시는 장애인 단체)에 위임하는 구조.
-- operator_name/operator_contact는 실제 수탁 기관 확인 후 채울 것 (TODO).
-- URL 출처: docs/site-research.md (화성은 사용자 확인 완료)
insert into municipalities (code, name, operator_type, operator_name, site_url, adapter_key, status, capabilities) values
  (
    'hwaseong', '화성시', 'welfare_org',
    '장애인 단체 수탁 (기관명 확인 필요)',
    'https://www.hsdr.or.kr/index_hsdr.jsp',    -- 화성시 현수막 게시대 접수처 (사용자 제공)
    'hwaseong', 'beta',
    '{"autoSubmit": true, "onlinePayment": false, "captchaType": "image"}'
  ),
  (
    'osan', '오산시', 'association',
    '한국옥외광고협회 오산시지부 (확인 필요)',
    'https://www.osankoaa.or.kr',               -- TODO(확인 필요): 지정게시대 현황 페이지 존재 확인됨, 접수 플로우 검증 필요
    'osan', 'beta',
    '{"autoSubmit": true, "onlinePayment": false, "captchaType": "unknown"}'
  )
on conflict (code) do nothing;

insert into municipality_specs (municipality_id, version, spec, window_rule, source_url)
select m.id, 1,
  '{
    "sizeCm": {"width": 500, "height": 70},
    "ratioTolerance": 0.03,
    "fileFormats": ["jpg", "jpeg"],
    "maxFileMb": 10,
    "colorRules": ["바탕색과 글자색의 명도 대비를 확보할 것", "형광·야광 색상 사용 금지"],
    "requiredTexts": ["게시기간 표기"],
    "prohibited": ["허위·과장 광고 문구", "음란·폭력적 표현", "타인 비방 내용"],
    "notes": ["개발용 플레이스홀더 규격 — 지자체 공고문 기준으로 검수 필요"]
  }'::jsonb,
  '{
    "openDayOfMonth": 1,
    "closeDayOfMonth": 5,
    "openTime": "09:00",
    "closeTime": "18:00",
    "timezone": "Asia/Seoul",
    "targetMonthOffset": 1,
    "selectionMethod": "lottery",
    "resultAfterCloseDays": 5
  }'::jsonb,
  m.site_url
from municipalities m
where m.code in ('hwaseong', 'osan')
on conflict (municipality_id, version) do nothing;
