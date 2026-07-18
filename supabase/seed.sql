-- 초기 시드: 화성시 · 오산시 레지스트리
-- 게시대 목록과 정확한 규격/일정은 어댑터 크롤 또는 admin UI로 갱신한다.
-- 아래 규격/일정 값은 개발용 플레이스홀더 — 운영 반영 전 각 지자체 공고문 기준으로 검수할 것.

-- 운영 주체: 지자체가 직접 운영하지 않고 수탁 기관(화성시는 장애인 단체)에 위임하는 구조.
-- operator_name/operator_contact는 실제 수탁 기관 확인 후 채울 것 (TODO).
-- 화성: 2026-07-18 실측 완료 (docs/site-research.md)
insert into municipalities (code, name, operator_type, operator_name, operator_contact, site_url, adapter_key, status, capabilities) values
  (
    'hwaseong', '화성시', 'welfare_org',
    '두리하나화성장애인자립센터',
    '031-366-7922',
    'https://www.hsdr.or.kr',
    'hwaseong', 'beta',
    '{"autoSubmit": true, "onlinePayment": false, "captchaType": "none"}'
  ),
  (
    'osan', '오산시', 'association',
    '한국옥외광고협회 오산시지부 (확인 필요)',
    null,
    'https://www.osankoaa.or.kr',               -- TODO(확인 필요): 지정게시대 현황 페이지 존재 확인됨, 접수 플로우 검증 필요
    'osan', 'beta',
    '{"autoSubmit": true, "onlinePayment": false, "captchaType": "unknown"}'
  )
on conflict (code) do nothing;

-- 화성 규격: 디자인 안내문 PDF(hsdr.or.kr/files/guide_20250602.pdf) 실측 (2026-07-18)
insert into municipality_specs (municipality_id, version, spec, window_rule, source_url)
select m.id, 1,
  '{
    "sizeCm": {"width": 600, "height": 70},
    "ratioTolerance": 0.03,
    "fileFormats": ["jpg", "jpeg", "png"],
    "maxFileMb": 10,
    "colorRules": [
      "바탕색은 흰색 또는 연한 아이보리(Y20)만 사용, 두 색 동시 사용 불가",
      "글자색은 지정 7색(검정 K100, 군청 C100M100, 청색 C100, 녹색 C100Y100, 연두 C50Y100, 노란색 M30Y80, 흙갈색 C50M80Y100K20) 중 5가지 이내",
      "적색류 글씨 절대 불가",
      "글자에 배경색 삽입 불가, 글자 그림자 불가"
    ],
    "requiredTexts": ["검인란(좌측 하단, 가로14cm×세로28cm): 상단에 업체명·전화번호 기입"],
    "prohibited": [
      "그림·사진 사용 금지 (등록된 상표 로고만 가로세로 50cm 이내, 좌우 한 곳만)",
      "부동산 광고에 평/평당/형 문구 사용 금지",
      "로고 좌우 동시 삽입 금지"
    ],
    "notes": [
      "글자 크기 60cm 이내, 최대 2줄",
      "자동 게시대 방식 — 우측 30cm 여백 필수 (표기 영역 좌20cm+본문550cm+우30cm)",
      "QR코드는 우측에만, 가로세로 30cm 이내",
      "봉미싱 마감 시 넓이 10cm 정도 제작"
    ]
  }'::jsonb,
  '{
    "openDayOfMonth": 1,
    "closeDayOfMonth": 5,
    "openTime": "00:00",
    "closeTime": "23:59",
    "timezone": "Asia/Seoul",
    "targetMonthOffset": 1,
    "selectionMethod": "lottery",
    "resultAfterCloseDays": 3
  }'::jsonb,
  'https://www.hsdr.or.kr/files/guide_20250602.pdf'
from municipalities m
where m.code = 'hwaseong'
on conflict (municipality_id, version) do nothing;

-- 오산: 실측 전 플레이스홀더
insert into municipality_specs (municipality_id, version, spec, window_rule, source_url)
select m.id, 1,
  '{
    "sizeCm": {"width": 600, "height": 70},
    "ratioTolerance": 0.03,
    "fileFormats": ["jpg", "jpeg"],
    "maxFileMb": 10,
    "notes": ["실측 전 플레이스홀더 — osankoaa.or.kr 공고 기준 검수 필요"]
  }'::jsonb,
  '{
    "openDayOfMonth": 1,
    "closeDayOfMonth": 5,
    "openTime": "00:00",
    "closeTime": "23:59",
    "timezone": "Asia/Seoul",
    "targetMonthOffset": 1,
    "selectionMethod": "lottery",
    "resultAfterCloseDays": 5
  }'::jsonb,
  m.site_url
from municipalities m
where m.code = 'osan'
on conflict (municipality_id, version) do nothing;
