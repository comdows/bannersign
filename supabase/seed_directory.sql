-- 지자체 접수처 디렉토리 시드 (2026-07-18 조사, docs/site-research.md)
-- 어댑터 미구현 지자체는 status='disabled' — 어댑터 구현+검증 후 beta/active로 전환.
-- adapter_key는 코드와 동일하게 예약해 둔다 (registry에 없으면 잡 실행 불가).
insert into municipalities (code, name, operator_type, operator_name, site_url, adapter_key, status, capabilities) values
  -- === uriad(directory1) 템플릿 — 화성과 동일 구조, 어댑터 팩토리 재사용 가능 ===
  ('gangseo',     '서울 강서구',  'city',        '강서구시설관리공단',            'https://gssi.uriad.com',                'gangseo',     'disabled', '{"autoSubmit": false, "onlinePayment": false, "captchaType": "unknown"}'),
  ('guro',        '서울 구로구',  'city',        '구로구시설관리공단',            'https://guro.uriad.com/public',         'guro',        'disabled', '{"autoSubmit": false, "onlinePayment": false, "captchaType": "unknown"}'),
  ('dongjak',     '서울 동작구',  'city',        '동작구시설관리공단',            'https://idongjak.uriad.com',            'dongjak',     'disabled', '{"autoSubmit": false, "onlinePayment": false, "captchaType": "unknown"}'),
  ('geumcheon',   '서울 금천구',  'city',        '금천구시설관리공단',            'https://gfmc.uriad.com',                'geumcheon',   'disabled', '{"autoSubmit": false, "onlinePayment": false, "captchaType": "unknown"}'),
  ('ansan',       '안산시',       'association', null,                            'https://ansan.uriad.com/public',        'ansan',       'disabled', '{"autoSubmit": false, "onlinePayment": false, "captchaType": "unknown"}'),
  ('gunpo',       '군포시',       'association', null,                            'https://www.uriad.com/gunpo',           'gunpo',       'disabled', '{"autoSubmit": false, "onlinePayment": false, "captchaType": "unknown"}'),
  ('anyang',      '안양시',       'association', '안양시광고협회',                'https://www.aykoaa.or.kr',              'anyang',      'disabled', '{"autoSubmit": false, "onlinePayment": false, "captchaType": "unknown"}'),
  ('yongin',      '용인시',       'association', null,                            'http://www.yikoaa.or.kr',               'yongin',      'disabled', '{"autoSubmit": false, "onlinePayment": false, "captchaType": "unknown"}'),
  ('pyeongtaek',  '평택시',       'association', null,                            'http://www.ptkoaa.co.kr',               'pyeongtaek',  'disabled', '{"autoSubmit": false, "onlinePayment": false, "captchaType": "unknown"}'),
  ('paju',        '파주시',       'association', null,                            'http://www.pjgoaa.or.kr',               'paju',        'disabled', '{"autoSubmit": false, "onlinePayment": false, "captchaType": "unknown"}'),
  ('gimpo',       '김포시',       'association', null,                            'http://www.kmkoaa.or.kr',               'gimpo',       'disabled', '{"autoSubmit": false, "onlinePayment": false, "captchaType": "unknown"}'),
  ('uiwang',      '의왕시',       'association', null,                            'http://www.uwkoaa.or.kr',               'uiwang',      'disabled', '{"autoSubmit": false, "onlinePayment": false, "captchaType": "unknown"}'),
  ('namyangju',   '남양주시',     'welfare_org', '권역별 3곳: 남양주 옥외광고(nyjkoaa B10) / 한국지체장애인협회 남양주시지회(nyjkappd B90) / 특수임무수행자 경기북부동지회(hid01 B93)', 'https://www.nyjkoaa.or.kr', 'namyangju', 'disabled', '{"autoSubmit": false, "onlinePayment": false, "captchaType": "unknown"}'),
  ('uijeongbu',   '의정부시',     'association', null,                            'http://www.ujbgoaa.or.kr/public',       'uijeongbu',   'disabled', '{"autoSubmit": false, "onlinePayment": false, "captchaType": "unknown"}'),
  -- === 기타 템플릿 (별도 어댑터 필요) ===
  ('suwon',       '수원시',       'city',        '수원시 직영(추정)',             'https://suwon.go.kr:22881',             'suwon',       'disabled', '{"autoSubmit": false, "onlinePayment": false, "captchaType": "unknown"}'),
  ('yangcheon',   '서울 양천구',  'city',        '양천구청 통합예약',             'https://www.yangcheon.go.kr',           'yangcheon',   'disabled', '{"autoSubmit": false, "onlinePayment": false, "captchaType": "unknown"}'),
  ('yeongdeungpo','서울 영등포구','city',        '영등포구 옥외광고시설물(y-sisul)', 'https://banner.y-sisul.or.kr',       'yeongdeungpo','disabled', '{"autoSubmit": false, "onlinePayment": false, "captchaType": "unknown"}'),
  ('bucheon',     '부천시',       'association', null,                            'https://www.bckoaa.com',                'bucheon',     'disabled', '{"autoSubmit": false, "onlinePayment": false, "captchaType": "unknown"}'),
  ('hanam',       '하남시',       'association', null,                            'https://www.hnkoaa.co.kr',              'hanam',       'disabled', '{"autoSubmit": false, "onlinePayment": false, "captchaType": "unknown"}'),
  ('gwangju_gg',  '광주시(경기)', 'association', null,                            'https://www.gjkoaa.co.kr',              'gwangju_gg',  'disabled', '{"autoSubmit": false, "onlinePayment": false, "captchaType": "unknown"}'),
  ('yangju',      '양주시',       'city',        '양주도시공사 환경관리팀',       'https://banner.yjuc.or.kr',             'yangju',      'disabled', '{"autoSubmit": false, "onlinePayment": false, "captchaType": "unknown"}')
on conflict (code) do update
  set operator_name = excluded.operator_name,
      site_url = excluded.site_url;
