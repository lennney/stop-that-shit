<p align="center">
  <img src="assets/stop-stamp.svg" alt="AI 코딩 에이전트의 작업 범위 이탈을 막는 STS STOP 도장" width="240">
</p>

<h1 align="center">Stop That Shit</h1>

<p align="center">
  <strong>수정은 끝났는데, AI는 아직도 확인 중인가요?</strong><br>
  AI 코딩 에이전트가 요청한 작업의 범위를 지키도록 돕는 Skill + Guard 플러그인입니다.<br>
  Claude Code · Codex · OpenCode · Hermes Agent CLI · Pi 지원<br>
  <a href="#설치">설치</a> · <a href="#사용법">사용법</a> ·
  <a href="EVIDENCE.md">평가 기록</a> · <a href="README.md">中文</a> ·
  <a href="README_EN.md">English</a>
</p>

필요한 확인이 끝난 뒤에도 같은 테스트와 검색을 반복하면, 결과는 그대로인데 시간과 사용량은 계속 듭니다.
이런 **과잉 검증**과 진전 없는 반복 작업, 이른바 **삽질**을 줄이고 싶어서 STS를 만들었습니다.
코드 리뷰가 파일 수정으로 바뀌거나, 결과 파일 옆에 쓰이지 않는 체크섬이 생기는 일도 같은 질문으로 살펴봅니다.

각각은 그럴듯한 작업입니다. 하지만 지금 요청을 끝내는 데 필요한지는 별개의 문제입니다.
Stop That Shit(STS)은 에이전트가 추가하려는 작업에 **왜 지금 필요한지** 묻게 하고,
명시한 작업 범위를 벗어나는 행동을 지원되는 Hook 경로에서 차단합니다.

## 어떤 상황에 쓰나요?

| 상황 | STS가 확인하는 기준 |
| --- | --- |
| 작은 수정이 대규모 리팩터링으로 번짐 | 요청이나 실제 호출 관계상 필요한 변경인가? |
| 쓰이지 않는 체크섬·호환 계층·방어 코드가 추가됨 | 이 결과를 사용하는 코드나 절차가 있는가? |
| 질문이나 리뷰 요청이 파일 수정으로 바뀜 | 사용자가 수정을 허용했는가? |
| 결론이 난 뒤에도 검색·테스트·검토가 반복됨 | 다음 확인이 어떤 판단을 바꾸는가? |

SHIT은 Scope creep, Hashing and hypothetical hardening, Intent violation,
Task thrashing의 약자입니다. 각각 작업 범위 확대, 불필요한 해시·방어 작업,
요청 의도 위반, 반복 작업을 뜻합니다.

필요한 테스트나 검증은 그대로 해야 합니다. 배포 절차에 체크섬이 필요하거나,
공유 인터페이스를 바꿔 전체 회귀 테스트가 필요하다면 그 작업에는 이유가 있습니다.
코드 줄 수, 소요 시간, 토큰 수만으로 작업을 막지 않습니다.

## 작동 방식

**Skill**은 추가 작업을 하기 전에 네 가지를 확인하도록 안내합니다.

1. 사용자가 요청했는가?
2. 현재 요청을 완료하는 데 필요한가?
3. 실제 코드, 데이터, 배포 조건, 완료 기준 중 무엇이 그 필요성을 뒷받침하는가?
4. 생략하면 현재 작업의 어느 부분이 실패하는가?

**Guard**는 `review`, `change` 같은 모드와 파일·의존성·해시·하위 에이전트 제한을
Hook에서 확인합니다. 명시된 경계를 넘었다고 판단할 수 있으면 거부 응답을 반환합니다.

```text
STOP / INTENT
Guard returned permission deny.
Reason: MODE_FORBIDS_MUTATION
State: ARMED / review
Event: evt_...
```

예를 들어 `review`로 리뷰를 요청했는데 에이전트가 파일 수정 도구를 호출하면
위와 같은 응답이 나옵니다. 이후 수정을 요청할 때는 `change`로 권한을 명시합니다.

## 설치

아래 명령은 고정된 버전 tag를 기준으로 합니다. 대부분의 호스트에는 Node.js 18 이상이 필요하며,
Pi 0.84.4에는 Node.js 22.19 이상이 필요합니다.
호스트별 설정과 업데이트 절차는 [설치 문서](INSTALL.md)를 확인하세요.

### Claude Code

Anthropic 공식 플러그인이 아닌 커뮤니티 오픈 소스입니다.
설치 전에 [훅 설정](hooks/hooks.json)과 [Skill 지침](skills/stop-that-shit/SKILL.md)을 읽고,
팀에서 외부 플러그인을 허용하는지 확인하세요. Hook은 실행 시점에 호출되는 스크립트이고,
Skill은 에이전트가 참고하는 작업 지침입니다.

**1. 저장소 받기.** 터미널에서 실행합니다.

```bash
git clone --branch 0.2.3 https://github.com/lennney/stop-that-shit.git
cd stop-that-shit
```

이미 저장소가 있다면 다시 복제하지 말고 사용할 버전과 현재 폴더를 확인하세요.

**2. 구조 확인 후 설치.** 저장소 루트에서 실행합니다.

```bash
claude plugin validate .
claude plugin marketplace add ./
claude plugin install stop-that-shit@stop-that-shit
```

`validate`는 플러그인 구조를 확인하는 단계이지, 모델의 행동 개선을 평가하는 단계가 아닙니다.
명령이 실패하면 다음 단계로 넘어가지 말고 오류를 먼저 확인하세요.

**3. 새 세션에서 리뷰로 확인.** Claude Code를 다시 시작하거나 `/reload-plugins`를 실행합니다.

```text
/stop-that-shit:stop-that-shit review -- 이 diff를 검토하고 문제점만 알려 주세요. 파일은 수정하지 마세요.
```

작은 변경 사항을 대상으로 시험하고, 리뷰 전후 `git diff`를 비교해 요청하지 않은 수정이 생기지 않았는지 확인하세요.
리뷰가 끝났다는 사실과 Guard가 동작했다는 사실은 다릅니다. 차단 여부는 Hook 기록도 함께 확인해야 합니다.

### Codex

```bash
codex plugin marketplace add lennney/stop-that-shit --ref 0.2.3
codex plugin add stop-that-shit@stop-that-shit
```

Codex를 다시 시작하고 새 CLI TUI에서 `/hooks`를 엽니다.
[패키지의 Hook 목록](INSTALL.md#review-the-packaged-hooks)과 명령을 확인한 뒤 신뢰하도록 설정합니다.
`--ref`는 설치 대상을 해당 버전으로 고정합니다.

### 다른 호스트

| 호스트 | 설치 안내 |
| --- | --- |
| OpenCode | [GitHub에서 설치](INSTALL.md#opencode-install-from-github) — Guard 설치 후 Skill 등록은 별도로 확인하세요. |
| Hermes Agent CLI | [플러그인 설치·활성화](INSTALL.md#hermes-agent-cli) — 활성화 후 CLI 또는 Gateway를 다시 시작합니다. |
| Pi Coding Agent | [Pi 설치 안내](INSTALL.md#pi-coding-agent) — 현재 어댑터의 검증 대상은 0.84.4입니다. |

## 사용법

명령은 메시지의 첫 번째 비어 있지 않은 줄에 하나씩 입력하세요.
인용문이나 코드 블록에 넣지 말고, 요청 내용은 `--` 뒤에 적습니다.
본문의 예시는 권한을 바꾸지 않습니다. 알 수 없는 필드나 충돌하는 값은
오류로 처리되며 기존 계약은 유지됩니다.

Claude Code에서는 접두어, 모드, `--`, 요청 순서로 입력합니다.

```text
/stop-that-shit:stop-that-shit change -- 실패하는 설정 테스트를 고쳐 주세요.
/stop-that-shit:stop-that-shit lock change files=src/config.cjs|test/config.test.cjs -- 이 파일 범위에서 설정 오류를 고쳐 주세요.
/stop-that-shit:stop-that-shit change deps=allow -- 요청한 파서 의존성을 추가해 주세요.
/stop-that-shit:stop-that-shit change hash=allow -- 배포 규약에 필요한 체크섬을 생성해 주세요.
```

Codex에서는 다음 형식을 사용합니다.

```text
$stop-that-shit review -- 이 변경 사항을 검토해 주세요. 수정하지 말고 발견한 문제만 알려 주세요.
$stop-that-shit change -- 실패하는 설정 테스트를 고쳐 주세요.
```

Claude Code 플러그인에서는 `$stop-that-shit` 대신
`/stop-that-shit:stop-that-shit`을 사용합니다.
Pi에서는 `/skill:stop-that-shit`을 사용합니다.

변경 범위를 미리 알고 있다면 파일을 제한할 수 있습니다.

```text
$stop-that-shit lock change files=src/config.cjs|test/config.test.cjs -- 설정 오류를 고쳐 주세요.
```

필요한 의존성이나 체크섬 작업은 명시적으로 허용합니다.

```text
$stop-that-shit change deps=allow -- 요청한 파서 의존성을 추가해 주세요.
$stop-that-shit change hash=allow -- 배포에 필요한 체크섬을 생성해 주세요.
```

어떤 파일을 고쳐야 할지 아직 모른다면 `files=`를 생략하세요.
에이전트가 실제 코드 경로를 확인하고 필요한 호출부와 테스트까지 수정할 수 있어야 합니다.
요청 내용은 `--` 뒤에 적습니다.

설치 직후에는 `OBSERVING / unconfirmed` 상태로 동작합니다.
관찰 결과를 기록하되, 이 상태에서는 차단하지 않습니다.
`review`, `answer`, `monitor`, `change`로 모드를 지정하면 Guard가 활성화됩니다.

## 설치했는데 작동하지 않는다면

| 증상 | 먼저 확인할 것 |
| --- | --- |
| `git`, `node`, `claude`를 찾을 수 없음 | 해당 프로그램 설치와 터미널의 PATH를 확인하고 터미널을 다시 여세요. |
| `validate`에서 파일 경로 오류 | 현재 폴더에 `.claude-plugin`과 `hooks`가 있는지 확인하세요. |
| 설치 후 명령을 사용할 수 없음 | Claude Code를 다시 시작하고 플러그인 설치·활성화 상태를 확인하세요. |
| 설치했지만 차단 기록이 없음 | Skill만 설치했는지, Hook이 연결됐는지, 작업 모드를 명시했는지 구분해 확인하세요. |

필요한 회귀 테스트까지 생략하는 방식으로 문제를 해결하지 마세요.
테스트 이름을 사용자가 직접 지정하지 않았어도, 실제 영향 범위를 검증하는 데 필요하면 수행해야 합니다.

## 불필요한 설명도 줄이고 싶다면

0.2.0부터 **Stop That Shit Slop(STSS)**을 별도 Skill로 제공합니다.
요청하지 않은 변명, 반복되는 단서, 가상의 반론에 대한 방어 문구를 살펴보고,
독자의 판단에 필요한 문장은 남기면서 나머지는 삭제하거나 다듬도록 안내합니다.
[STSS 안내](skills/stss/SKILL.md)를 참고하세요.

## 적용 범위와 평가

STS는 모델의 추론 능력이나 서비스의 사용량 한도를 바꾸지 않습니다.
토큰 절감률이나 모든 작업에서의 품질 향상을 보장하지도 않습니다.
프로젝트는 Codex와 GPT-5.6 사용 경험에서 시작했으며,
공개 평가 환경과 결과는 [EVIDENCE.md](EVIDENCE.md)에 기록되어 있습니다.

Skill만 설치하면 행동 지침만 제공됩니다. Guard가 차단할 수 있는 범위는
호스트가 지원되는 Hook으로 전달하는 동작에 한정됩니다.
거부 응답이 기록되었다는 사실만으로 실제 실행이 멈췄다고 단정할 수는 없습니다.
보안 샌드박스가 필요하다면 호스트의 권한 설정도 함께 사용해야 합니다.

## 피드백

불필요한 작업을 막지 못했거나, 꼭 필요한 작업을 막았다면
[GitHub Issue](https://github.com/lennney/stop-that-shit/issues)에 알려 주세요.
사용한 호스트와 버전, 요청 내용, 에이전트가 하려던 동작, 기대한 결과를 적으면
원인을 확인하는 데 도움이 됩니다. 코드와 로그에 포함된 개인정보와 비밀 값은 제거해 주세요.

한국어 설명이 어색하거나 이해하기 어려운 부분도 수정 제안을 환영합니다.
[기여 안내](CONTRIBUTING.md) · [사례 모음](cases/README.md) · [MIT 라이선스](LICENSE)
