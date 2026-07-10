# Gmail 지원 이력 자동 정리

Node.js 26에서 Gmail API로 최근 채용/입사지원 관련 이메일을 가져오고, Codex CLI로 기업명/직무명/지원일/상태를 분석해 `data/applications.json`에 저장한 뒤 로컬 HTML 화면으로 보여주는 프로젝트입니다.

## 설치 방법

```bash
npm install
```

Node.js 26 이상이 필요합니다.

## .env 설정 방법

`.env.example`을 복사해 `.env`를 만들고 값을 채웁니다.

```bash
cp .env.example .env
```

필수 값:

```env
GOOGLE_CLIENT_ID=your-google-oauth-client-id
GOOGLE_CLIENT_SECRET=your-google-oauth-client-secret
```

선택 값:

```env
GOOGLE_REDIRECT_URI=http://127.0.0.1:42813/oauth2callback
GOOGLE_TOKEN_PATH=token.json
GOOGLE_OAUTH_TIMEOUT_MS=300000
PORT=3000
CODEX_COMMAND=codex
CODEX_EXEC_ARGS=--ask-for-approval never exec --sandbox workspace-write -C . --skip-git-repo-check
```

민감정보와 OAuth 토큰은 코드에 하드코딩하지 않고 `.env`와 `token.json`을 사용합니다. 두 파일은 `.gitignore`에 포함되어 있습니다.

Gmail 메일함은 사용자 소유 데이터이므로 Google API 키만으로는 조회할 수 없습니다. 이 프로젝트는 OAuth로 사용자의 동의를 받은 뒤 `gmail.readonly` 권한의 토큰을 저장해 사용합니다.

## Gmail OAuth 설정 방법

1. Google Cloud Console에서 프로젝트를 만들고 Gmail API를 활성화합니다.
2. OAuth 동의 화면을 설정합니다.
3. OAuth 클라이언트 ID를 생성합니다.
4. 로컬에서만 사용할 경우 애플리케이션 유형은 데스크톱 앱을 권장합니다.
5. 웹 애플리케이션 OAuth 클라이언트를 사용하는 경우 승인된 리디렉션 URI에 `.env`의 `GOOGLE_REDIRECT_URI` 값을 정확히 등록합니다. 기본값은 `http://127.0.0.1:42813/oauth2callback`입니다.
6. 발급된 클라이언트 ID와 클라이언트 시크릿을 `.env`에 입력합니다.

최초 실행 시 로컬 OAuth 콜백 서버가 잠시 실행되고 기본 브라우저에 Google 로그인 화면이 열립니다. 로그인과 권한 동의가 끝나면 앱이 인증 코드를 자동으로 받아 `token.json`에 토큰을 저장합니다. 이후 실행부터는 저장된 토큰을 사용합니다.

Google 화면에서 `redirect_uri_mismatch`가 보이면 OAuth 클라이언트 유형을 데스크톱 앱으로 다시 만들거나, 웹 애플리케이션 OAuth 클라이언트의 승인된 리디렉션 URI와 `.env`의 `GOOGLE_REDIRECT_URI` 값을 같은 URL로 맞추세요.

## 실행 방법

```bash
node app.js
```

또는:

```bash
npm start
```

실행 흐름:

1. `LEA.md`에서 `last_email_accessed_at` 값을 읽습니다.
2. Gmail API로 채용/입사지원 관련 이메일을 조회합니다.
3. 이메일의 제목, 본문, 발신자, 수신일, 링크를 `tmp/emails.json`에 저장합니다.
4. Node.js `child_process`로 Codex CLI를 실행해 `tmp/codex-result.json`을 생성합니다.
5. 분석 결과를 `data/applications.json`에 병합 저장합니다.
6. 로컬 웹서버를 실행합니다.
7. 서버까지 정상 실행되면 `LEA.md`를 갱신합니다.

## 최초 실행과 재실행의 차이

`LEA.md`의 `last_email_accessed_at` 값이 없거나 파싱에 실패하면 최근 6개월 기준으로 조회합니다. 작업이 성공하면 가장 최근 이메일 수신일 또는 현재 시간이 아래 형식으로 저장됩니다.

```md
# Last Email Access

last_email_accessed_at: 2026-06-30T12:00:00+09:00
```

재실행 시에는 이 시간 이후에 수신된 이메일만 분석합니다.

## HTML 화면 접속 주소

기본 주소는 다음과 같습니다.

```text
http://localhost:3000
```

화면은 `data/applications.json`을 읽어 표로 표시합니다. 기업명/직무명 검색, 상태 필터, 지원 날짜 또는 이메일 수신일 기준 정렬을 제공합니다.

## applications.json 데이터 구조

`data/applications.json`은 JSON 배열입니다.

```json
[
  {
    "companyName": "ABC테크",
    "position": "백엔드 개발자",
    "jobPostingUrl": "https://example.com/job/123",
    "platform": "사람인",
    "appliedAt": "2026-03-12",
    "status": "불합격",
    "evidenceEmailSubject": "[ABC테크] 전형 결과 안내",
    "evidenceEmailReceivedAt": "2026-03-20T10:00:00+09:00"
  }
]
```

같은 기업, 같은 직무, 같은 지원 날짜는 중복으로 저장하지 않고 최신 근거 이메일 기준으로 상태와 근거를 업데이트합니다. 기업명이 같아도 직무명 또는 지원 날짜가 다르면 별도 항목으로 저장합니다.

상태 값은 `지원완료`, `서류합격`, `면접진행`, `최종합격`, `불합격`, `알수없음` 중 하나로 정규화됩니다.

## 가정사항

- Codex CLI 기본 명령은 `codex`이고, 비대화형 실행은 `codex exec`를 사용한다고 가정합니다. 다른 설치 형태라면 `.env`의 `CODEX_COMMAND` 또는 `CODEX_EXEC_ARGS`를 조정합니다.
- Gmail 검색은 `after:YYYY/MM/DD`와 키워드 OR 조건으로 1차 조회한 뒤, Node.js에서 `last_email_accessed_at` 이후 수신 메일만 다시 필터링합니다.
- Gmail OAuth 리디렉션은 `.env`의 `GOOGLE_REDIRECT_URI` 값으로 로컬 콜백 서버를 잠시 띄워 처리합니다.
- 지원 날짜가 분석 결과에 없으면 근거 이메일 수신일의 날짜를 사용합니다.
- Codex CLI는 `tmp/codex-result.json` 외의 파일을 수정하지 않도록 프롬프트로 제한합니다.
