-- 초기 시드: 화성시 · 오산시 레지스트리
-- 게시대 목록과 정확한 규격/일정은 어댑터 크롤 또는 admin UI로 갱신한다.
-- 아래 규격/일정 값은 개발용 플레이스홀더 — 운영 반영 전 각 지자체 공고문 기준으로 검수할 것.

insert into municipalities (code, name, operator_type, site_url, adapter_key, status, capabilities) values
  (
    'hwaseong', '화성시', 'association',
    'https://example-hwaseong-banner.kr',       -- TODO: 실제 화성시 게시대 신청 사이트 URL로 교체
    'hwaseong', 'beta',
    '{"autoSubmit": true, "onlinePayment": false, "captchaType": "image"}'
  ),
  (
    'osan', '오산시', 'association',
    'https://example-osan-banner.kr',           -- TODO: 실제 오산시 게시대 신청 사이트 URL로 교체
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
