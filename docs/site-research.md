# 지자체별 현수막 게시대 접수처 디렉토리

최종 갱신: 2026-07-18. 출처: 사용자 제공 블로그 디렉토리(서울.경기 게시대 안내,
blog.naver.com/s3833323)의 지자체별 포스트 30건 크롤 + 각 사이트 직접 확인.

## 템플릿 분류 (어댑터 전략)

| 템플릿 | 마커 | 어댑터 |
|---|---|---|
| **uriad(directory1)** | `directory1/map_view.jsp`, `fnBorder()/fnMapSmallShow()`, `sub03.jsp`의 `r_STARTDAY` hidden, `top_login.jsp` #id/#pw | `packages/adapters/src/uriad/factory.ts` — `createUriadAdapter()` 재사용 (약 20곳) |
| newkoaa(PHP) | `/map/newkoaa_*/?map_id=`, `/skin_gyeonggi/` | 미구현 — 별도 어댑터 필요 |
| 구청 직영/기타 | 예약시스템·자체 구축 | 지자체별 개별 어댑터 |

## uriad 템플릿 접수처

| 지자체 | 접수처 | 수탁 기관 | bizoff | 상태 |
|---|---|---|---|---|
| **화성시** | hsdr.or.kr | 두리하나화성장애인자립센터 (031-366-7922) | B40 | **실측 완료** — 접수 매월 1~5일 추첨, 게시대 197곳(600×70, 13,000원/7일), 디자인 규정 PDF 확보, 어댑터 beta(autoSubmit) |
| 시흥시 | siheung.uriad.com | (확인 필요) | — | sub03 r_STARTDAY까지 동일 구조 확인 — 어댑터 등록(beta, autoSubmit=false) |
| 오산시 | osankoaa.or.kr | 오산시광고협회 | B30 | uriad 템플릿이나 sub03에 r_STARTDAY 미확인(추첨 경로 상이 가능) — 어댑터 등록(autoSubmit=false) |
| 서울 강서구 | gssi.uriad.com | 강서구시설관리공단 | — | 디렉토리 등록 |
| 서울 구로구 | guro.uriad.com/public | 구로구시설관리공단 | — | 디렉토리 등록 |
| 서울 동작구 | idongjak.uriad.com | 동작구시설관리공단 | — | 디렉토리 등록 |
| 서울 금천구 | gfmc.uriad.com | 금천구시설관리공단 | I91 | 디렉토리 등록 |
| 안산시 | ansan.uriad.com/public | — | — | sub03 경로 상이(404) — 경로 실측 필요 |
| 군포시 | uriad.com/gunpo | — | B08 | 디렉토리 등록 |
| 안양시 | aykoaa.or.kr | 안양시광고협회 | — | 디렉토리 등록 |
| 용인시 | yikoaa.or.kr | — | B31 | http 접근 이슈(프록시 403) — https/경로 확인 필요 |
| 평택시 | ptkoaa.co.kr | — | B36 | 〃 |
| 파주시 | pjgoaa.or.kr | — | B35 | 디렉토리 등록 |
| 김포시 | kmkoaa.or.kr | — | B05 | 디렉토리 등록 |
| 의왕시 | uwkoaa.or.kr | — | B32 | 디렉토리 등록 |
| 남양주시 | nyjkoaa.or.kr 외 | **권역별 3곳**: 남양주 옥외광고(B10) / 지체장애인협회 남양주시지회 nyjkappd(B90) / 특수임무수행자 경기북부동지회 hid01.com(B93) | — | 다중 수탁 — 게시대→수탁처 매핑 필요 |
| 의정부시 | ujbgoaa.or.kr/public | — | — | 디렉토리 등록 |
| (미확정) | gpgoaa.or.kr, ssmu.co.kr(B17), icaa.or.kr(B34), mountad.co.kr | 지자체 매핑 미확정 | — | 후속 확인 |

## 기타 템플릿 접수처

| 지자체 | 접수처 | 비고 |
|---|---|---|
| 수원시 | suwon.go.kr:22881 | 시 직영 시스템(passni) — 별도 어댑터 |
| 서울 양천구 | yangcheon.go.kr 통합예약 | 구청 예약시스템 |
| 서울 영등포구 | banner.y-sisul.or.kr | 영등포구 옥외광고시설물(PHP) |
| 부천시 | bckoaa.com | newkoaa 템플릿 |
| 하남시 | hnkoaa.co.kr | newkoaa 템플릿 |
| 광주시(경기) | gjkoaa.co.kr | newkoaa 템플릿 |
| 양주시 | banner.yjuc.or.kr | 양주도시공사 환경관리팀 |
| (미확정) | gayaad.kr, koaagj.co.kr, yoaa.co.kr | 지자체 매핑 미확정 (고양/양평 추정) |

## 게시대 위치 데이터 소스

- 공공데이터포털 전국현수막게시대시설표준데이터: https://www.data.go.kr/data/15129434/standard.do
- 경기데이터드림 현수막지정게시대 현황: https://data.gg.go.kr
- uriad 템플릿은 `sub02.jsp`(게시대현황) 크롤로 좌표·요금·면수까지 수집 가능 (화성 197곳 시드 완료)

## 확장 절차 (uriad 템플릿 기준)

1. `sub02.jsp`/`sub03.jsp` 존재·구조 확인 (healthCheck와 동일 체크)
2. `createUriadAdapter({key, nameKo, baseUrl, paths})` 등록 + registry 추가 (autoSubmit=false)
3. seed_directory.sql에서 해당 지자체 status → 'beta'
4. 게시대 크롤 시드 생성, 규격 공고 확보(municipality_specs)
5. 실계정 dry-run 리허설(제출 직전까지) 통과 → autoSubmit=true, status='active'
