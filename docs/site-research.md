# 지자체별 현수막 게시대 신청 사이트 조사

최종 갱신: 2026-07-18. **사용자 제공 정보가 최우선** (개발 환경 프록시가 해당 사이트
접속을 차단해 자동 검증 불가 — 실측은 실제 방문 기준으로 진행).

## 확정/제공된 접수처 (사용자 확인)

| 지자체 | 접수 사이트 | 운영(수탁) 기관 | 비고 |
|---|---|---|---|
| **화성시** | https://www.hsdr.or.kr/index_hsdr.jsp | 장애인 단체 수탁 (기관명 확인 필요) | 사용자 제공 — 어댑터 baseUrl 반영됨 |
| **용인시** | https://banner.yjuc.or.kr | 양주도시공사 환경관리팀(현수막게시대) 표기 | 사용자 제공. 도메인(yjuc=양주도시공사)과 지자체가 달라 보이므로 방문 시 실제 관할 확인 권장 |
| **서울 구로구** | https://guro.uriad.com/public/index.jsp | 미상 (uriad 솔루션) | 사용자 제공 |
| 오산시 | https://www.osankoaa.or.kr | 한국옥외광고협회 오산시지부(추정) | 검색 확인(지정게시대 현황 페이지 존재), 접수 플로우 미검증 |
| 수원시 | **미확인** | — | 이전 후보(swkoaa.or.kr)는 오류로 판명 — 재조사 필요 |

## 접수처 디렉토리 참고 자료

- 지자체별 접수처를 버튼 링크로 정리한 블로그 (사용자 제공):
  https://m.blog.naver.com/PostView.naver?blogId=s3833323&logNo=224329611475
  → 신규 지자체 어댑터 추가 시 이 글에서 접수처 URL을 우선 확인할 것

## 솔루션 벤더 패턴 (어댑터 재사용 기회)

- **uriad.com**: `guro.uriad.com`(구로구), `gongdan.uriad.com`(성북구도시관리공단) —
  멀티테넌트 게시대 접수 솔루션으로 보임. 같은 벤더면 어댑터 하나로 여러 지자체 커버 가능
- **yjuc 계열 템플릿**: `banner.yjuc.or.kr`(sub02-01.jsp 게시대 추첨 신청)과
  `osankoaa.or.kr`(sub02-02.jsp 지정게시대 현황)이 동일 템플릿으로 보임
- **koaa 지부 도메인**: `{약어}koaa.or.kr` — 옥외광고협회 지부 운영 지역에서 관찰
  (단, 수원 swkoaa는 오류였음 — 도메인 패턴만으로 단정하지 말 것)

## 게시대 위치 데이터 소스

- 공공데이터포털 전국현수막게시대시설표준데이터: https://www.data.go.kr/data/15129434/standard.do
- 경기데이터드림 현수막지정게시대 현황: https://data.gg.go.kr

## 다음 단계

1. 화성 hsdr.or.kr 실측: 접수 메뉴 경로, 로그인 방식, 신청 폼 필드/셀렉터, 캡차 여부
   → `packages/adapters/src/hwaseong/config.ts` 교체 + fixtures를 실제 HTML로 갱신
2. 오산 osankoaa.or.kr 접수 플로우 확인 → osan 어댑터 구현
3. uriad.com 솔루션 구조 파악 → 공통 어댑터 베이스 추출 검토 (구로 등 서울권 확장)
4. 실창구 dry-run 통과 후 municipalities.status를 active로 전환
