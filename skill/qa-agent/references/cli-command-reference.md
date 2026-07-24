# QA Agent CLI Reference

## Common commands

| Command | Purpose |
| --- | --- |
| `qa-agent init` | Initialize the current project and selected host integrations. |
| `qa-agent check "REQUEST"` | Create or resume an ordinary AI-led Task; never starts a Run. |
| `qa-agent check --mode guided --request "REQUEST"` | Create or resume a QA-led, step-by-step Task; never starts a Run. |
| `qa-agent continue` | Continue the Task bound to the current Session. |
| `qa-agent finish` | Close the current Session without archiving the Task. |
| `qa-agent doctor` | Inspect project and host-tool readiness. |
| `qa-agent update` | Refresh managed files for a project created by the same Runtime version. |

`qa-agent doctor --platforms web|ios` reports the local unified Runner and selected adapter prerequisites. Missing Python/Playwright blocks Web; missing Python/`xcrun simctl`/`idb`/a booted Simulator blocks iOS. Run Doctor again after each repair.

## Planning and approval

| Command | Purpose |
| --- | --- |
| `qa-agent plan apply --file PLAN.json` | Apply a structured PlanDraft and update Task `prd.md`. The Agent must infer a unique platform and set `platformDeclaration` plus `executionIntent`; ask the QA only when platform evidence is ambiguous. |
| `qa-agent plan review --module MODULE --task TASK --approve --confirmed-by HUMAN --confirmation-text "确认测试并开始执行"` | For an eligible read-only Task, record both PRD review and start authorization in one Runtime operation. |
| `qa-agent plan review --module MODULE --task TASK --approve --confirmed-by HUMAN --confirmation-text "确认测试方案"` | In strict mode, record that the QA reviewed the full PRD and confirmed it matches the requirement. Fails while the platform is missing or `userQuestions` remain. |
| `qa-agent review --module MODULE --task TASK --approve --confirmed-by HUMAN --confirmation-text "确认开始测试"` | In strict mode, record the separate authorization to begin execution. Requires a current PRD review. |
| `qa-agent test --module MODULE --task TASK [--scenario ID]` | Start or resume the Task's single Source Run only after both approvals. |

The execution order is mandatory for both Quick and Guided modes:

```text
qa-agent check [--mode guided]
→ inspect project and build detailed Scenario steps
→ qa-agent plan apply
→ present complete Task prd.md
→ resolve every QA question and reapply the plan
→ QA replies with the exact phrase required by confirmationMode
→ qa-agent plan review (merged records both approvals; strict records plan review)
→ qa-agent review only for strict Tasks
→ qa-agent test
```

Before the computed confirmation is complete, `qa-agent test` fails without creating a Run and UI tools remain forbidden. `merged` uses `确认测试并开始执行`; `strict` uses `确认测试方案` followed by `确认开始测试`.

## UI execution (act commands)

Only Web and iOS Simulator are supported. All UI interactions use `qa-agent act` through the built-in Runner; each command auto-screenshots and auto-records to the active Run. Direct MCP, Playwright, xcrun, idb, ADB, and other UI tools are forbidden.

| Command | Purpose |
| --- | --- |
| `qa-agent act navigate --run RUN --url URL` | Navigate to a URL (web). |
| `qa-agent act click --run RUN --locator "strategy=value"` | Click an element (web). |
| `qa-agent act fill --run RUN --locator "strategy=value" --input-ref KEY` | Fill input with secret ref (web). |
| `qa-agent act fill --run RUN --locator "strategy=value" --value TEXT` | Fill input with plain text (web). |
| `qa-agent act select --run RUN --locator "strategy=value" --value VAL` | Select dropdown option (web). |
| `qa-agent act assert-text --run RUN --locator "strategy=value" --expected TEXT` | Assert element text. |
| `qa-agent act assert-visible --run RUN --locator "strategy=value"` | Assert element visible. |
| `qa-agent act assert-value --run RUN --locator "strategy=value" --expected TEXT` | Assert an exact input value (web) or iOS accessibility value. |
| `qa-agent act assert-not-visible --run RUN --locator "strategy=value"` | Assert element does not exist or is not visible. |
| `qa-agent act assert-attribute --run RUN --locator "strategy=value" --attribute ATTR --expected TEXT` | Assert a specific element attribute value. |
| `qa-agent act assert-count --run RUN --locator "strategy=value" --expected N` | Assert the number of matching elements. |
| `qa-agent act check --run RUN --locator "strategy=value"` | Check a checkbox or radio button (web). |
| `qa-agent act uncheck --run RUN --locator "strategy=value"` | Uncheck a checkbox (web). |
| `qa-agent act toggle --run RUN --locator "strategy=value" [--checked true\|false]` | Toggle a UISwitch/checkmark to desired state (iOS). |
| `qa-agent act get-text --run RUN --locator "strategy=value"` | Extract element text/value for downstream use. |
| `qa-agent act accept-dialog --run RUN [--locator "strategy=value"] [--text TEXT]` | Accept a JS dialog (web) or tap the allow button on a system alert (iOS). |
| `qa-agent act dismiss-dialog --run RUN [--locator "strategy=value"]` | Dismiss a JS dialog (web) or tap cancel on a system alert (iOS). |
| `qa-agent act upload --run RUN --locator "strategy=value" --file-path PATH` | Set files on an `<input type=file>` element (web). |
| `qa-agent act tap --run RUN --locator "strategy=value"` | Semantically tap an iOS element from the current accessibility tree. |
| `qa-agent act tap --run RUN --x N --y N` | Tap coordinates (iOS fallback only). |
| `qa-agent act type-text --run RUN --text TEXT` | Type text (iOS). |
| `qa-agent act clear --run RUN --locator "type=TextField" [--max-chars N]` | Clear a focused iOS text field with HID events. |
| `qa-agent act swipe --run RUN --direction DIR` | Swipe in a direction (iOS). |
| `qa-agent act key --run RUN --keycode KEY` | Send a named or numeric iOS HID key, such as `return`, `right`, or `backspace`. |
| `qa-agent act launch --run RUN --bundle-id ID` | Launch app (iOS). |
| `qa-agent act terminate --run RUN --bundle-id ID` | Terminate an iOS app before a deterministic launch. |
| `qa-agent act install --run RUN --app-path PATH` | Install an iOS app on the selected Simulator. |
| `qa-agent act home --run RUN` | Press Home button (iOS). |
| `qa-agent act back --run RUN` | Press Back button (iOS). |
| `qa-agent act describe --run RUN` | Get accessibility tree (iOS). |
| `qa-agent act wait --run RUN --ms N` | Wait for duration. |
| `qa-agent act wait --run RUN --locator "strategy=value"` | Wait for element. |
| `qa-agent act screenshot --run RUN --name NAME` | Take named screenshot. |
| `qa-agent act scroll --run RUN --direction DIR` | Scroll using dynamic accessibility-tree bounds (web, iOS). |
| `qa-agent act hover --run RUN --locator "strategy=value"` | Hover element (web). |

Locator format: `strategy=value` (e.g. `role=button:Login`, `css=#submit`, `text=Welcome`).

For iOS, `text=`, `label=`, and `accessibility=` first prefer an exact accessibility value and then support a unique semantic match inside a compound `AXLabel` (for example `text=Bvlgari` matches `Bvlgari\nAviator Sunglasses...`). Ambiguous or invisible matches fail with an actionable error. Use `type=TextField` for native text fields and `value=...` for an exact `AXValue` lookup.

The project includes a complete iOS example at [`ios-search-bvl.steps.json`](../../../ios-search-bvl.steps.json). It exercises launch, semantic text-field focus, HID clear, fill, `assert-value`, Return, semantic product tap, detail-page `assert-text`, dynamic scroll, and cleanup:

```bash
PYTHONPATH=runner \
QA_AGENT_SCREENSHOT_DIR=/tmp/qa-agent-ios-example/screenshots \
QA_AGENT_RESULT_PATH=/tmp/qa-agent-ios-example/result.json \
python3 -m qa_agent_runner replay ios-search-bvl.steps.json
```

The JSON keeps native iOS commands (`tap`, `fill`, `clear`, `scroll`, `assert-text`) instead of converting them to Web `click` or `fill` actions.

## Runtime execution

| Command | Purpose |
| --- | --- |
| `qa-agent run step RUN ...` | Persist one real UI action and screenshot. |
| `qa-agent run observe RUN ...` | Persist one declared business assertion. |
| `qa-agent run cleanup RUN ...` | Persist one declared Cleanup result. |
| `qa-agent run complete RUN` | Complete the Run and generate the Runtime report. |

The approved initial execution is stored at:

```text
source-run/run.json
source-run/report.md
source-run/screenshots/
source-run/evidence/
```

There is no exploratory `runs/<run-id>/` history. Before formal script publication, another initial test replaces the Source Run. After publication, it is frozen and later execution must use `regression-runs/`.

## Guided QA commands

| Command | Purpose |
| --- | --- |
| `qa-agent run guide-approve RUN --scenario ID --planned-step STEP --confirmed-by HUMAN --confirmation-text TEXT` | Persist QA approval for exactly one PRD step. |
| `qa-agent run guide-approve RUN --scenario ID --action TEXT --expected TEXT --confirmed-by HUMAN --confirmation-text TEXT` | Persist one QA-added action and its explicit expected result. |
| `qa-agent run guide-verdict RUN --step STEP --status passed|failed|blocked|paused|inconclusive|adapted --confirmed-by HUMAN --confirmation-text TEXT [--note TEXT]` | Persist the QA judgment of the observed result. |

A Guided UI step cannot run without a pending action approval. After it runs, Runtime sets it to `blocked` and blocks further UI until the QA verdict is recorded. `run complete` rejects any Guided UI step without a human verdict.

## PlanDraft example

```json
{
  "apiVersion": "qa-agent/plan-draft/v1",
  "moduleId": "onboarding",
  "taskId": "welcome-dialog-first-install",
  "description": "验证首次安装展示 Welcome Dialog，后续启动不重复展示。",
  "objectives": ["验证 Welcome Dialog 首次展示和持久化状态"],
  "executionIntent": "read-only",
  "scope": { "platforms": ["ios"], "environments": ["local"], "roles": ["default"] },
  "platformDeclaration": { "platform": "ios", "statement": "本次测试平台：iOS Simulator", "declaredBy": "qa-agent" },
  "userQuestions": [],
  "confirmedDecisions": ["Continue as Guest 关闭弹窗并进入首页"],
  "scenarios": [{
    "id": "first-install",
    "title": "首次安装与再次启动",
    "intent": "验证 Welcome Dialog 只在首次启动显示",
    "expected": { "outcome": "首次显示，确认后再次启动不显示" },
    "steps": [
      { "id": "install", "action": "安装全新 App", "expected": "App 成功安装" },
      { "id": "launch", "action": "打开 App", "expected": "Splash Screen 正常出现" },
      { "id": "welcome", "action": "等待进入首页", "expected": "Home Screen 和 Welcome Dialog 同时显示" },
      { "id": "guest", "action": "点击 Continue as Guest", "expected": "Dialog 关闭并展示首页" },
      { "id": "restart", "action": "重启 App", "expected": "Welcome Dialog 不再出现" }
    ]
  }]
}
```

## Regression steps

Runtime exports structured steps from completed Runs. The Agent never writes Python scripts. See `references/regression-runner.md` for the full contract.

| Command | Purpose |
| --- | --- |
| `qa-agent regression export --module MODULE --task TASK --run RUN [--id ID]` | Export steps from a completed Run. |
| `qa-agent regression drafts [--session KEY]` | List current Session drafts. |
| `qa-agent regression draft-show ID [--session KEY]` | Show a draft and its steps. |
| `qa-agent regression publish --module MODULE --task TASK --draft ID --confirmed-by HUMAN` | Publish reviewed steps into the Task. |
| `qa-agent regression list --module MODULE --task TASK` | List formal Task steps. |
| `qa-agent regression show ID --module MODULE --task TASK` | Show a formal steps manifest. |
| `qa-agent regression run ID --module MODULE --task TASK` | Replay published steps via the built-in runner. |
| `qa-agent task regression show|run TASK --module MODULE` | Show or run validated steps for one Task. |
| `qa-agent module regression show|run MODULE [--priority p0|p1|p2|p3]` | Show or run validated steps for a Module. |

## Release, archive, and administration

| Command | Purpose |
| --- | --- |
| `qa-agent impact analyze` | Resolve changed-file impact. |
| `qa-agent release check --profile fast|normal|full [--plan-only]` | Select and optionally run validated regression steps for release. |
| `qa-agent archive --module MODULE --task TASK` | Archive only after regression coverage, evidence, Cleanup, and memory gates pass. |
| `qa-agent session bind --module MODULE --task TASK` | Bind a Task to the current Session. |
| `qa-agent validate` | Validate project assets. |
| `qa-agent index rebuild` | Rebuild project indexes. |
| `qa-agent skill validate` | Validate the installable three-Skill package. |
