# QA Agent CLI Reference

## Common commands

| Command | Purpose |
| --- | --- |
| `qa-agent init` | Initialize the current project and selected host integrations. |
| `qa-agent check "REQUEST"` | Create or resume an ordinary Task and write its reviewable `prd.md`; never starts a Run. |
| `qa-agent continue` | Continue the Task bound to the current Session. |
| `qa-agent finish` | Close the current Session without archiving the Task. |
| `qa-agent doctor` | Inspect project and host-tool readiness. |
| `qa-agent update --migrate` | Update managed host files and migrate legacy assets. |

`qa-agent doctor` also reports the advisory Web and iOS regression stack from `references/recommended-regression-stack.md`, including Python, pytest, Playwright, simctl, fb-idb, idb_companion, optional ios-simulator-mcp availability. Missing recommended tools do not block QA Agent when another approved adapter satisfies the result contract.

## Planning and execution

| Command | Purpose |
| --- | --- |
| `qa-agent plan apply --file PLAN.json` | Apply a structured PlanDraft with detailed Scenario `steps`; Runtime updates Task `prd.md`. |
| `qa-agent review --module MODULE --task TASK --approve --confirmed-by HUMAN --confirmation-text "确认开始测试"` | Record the exact reviewed start confirmation for the current plan. |
| `qa-agent test --module MODULE --task TASK [--scenario ID]` | Start or resume the Task's single Source Run only after current PRD approval. |
| `qa-agent run step RUN ...` | Persist one real UI action and screenshot. |
| `qa-agent run observe RUN ...` | Persist one business assertion. |
| `qa-agent run cleanup RUN ...` | Persist one declared Cleanup result. |
| `qa-agent run complete RUN` | Complete the Run and generate the Runtime report. |

The execution order is mandatory:

```text
qa-agent check / qa-agent start
→ inspect project and build detailed Scenario steps
→ qa-agent plan apply
→ present Task prd.md
→ user replies exactly “确认开始测试”
→ qa-agent review --confirmation-text "确认开始测试"
→ qa-agent test
```

Before the exact confirmation, `qa-agent test` fails without creating a Run and UI tools remain forbidden. The approved initial execution is stored at:

```text
source-run/run.json
source-run/report.md
source-run/screenshots/
source-run/evidence/
```

There is no exploratory `runs/<run-id>/` history. Before formal script publication, another initial test replaces the Source Run. After publication, it is frozen and later execution must use `regression-runs/`.

A PlanDraft Scenario should include reviewable steps:

```json
{
  "id": "sold-product",
  "title": "已售出/不可用商品",
  "intent": "验证已售出商品的购买按钮不可用",
  "expected": { "outcome": "Buy Now 不可点击或被替换" },
  "steps": [
    { "id": "find-sold", "action": "找到标记为 SOLD 的商品", "expected": "可以识别已售商品" },
    { "id": "open-detail", "action": "进入商品详情页", "expected": "详情页正常加载" },
    { "id": "verify-state", "action": "检查 Sold 标记和购买按钮", "expected": "Sold 可见且 Buy Now 不可用" },
    { "id": "capture", "action": "截取结果页面", "expected": "截图保存到对应 Task Source Run" }
  ]
}
```

## Python regression scripts

Runtime never generates Python. The Agent writes a script only after the user requests a draft, and publication requires a second explicit approval.

| Command | Purpose |
| --- | --- |
| `qa-agent regression draft --module MODULE --task TASK --run RUN --file SCRIPT.py [--id ID]` | Validate and save an Agent-authored Session draft. |
| `qa-agent regression drafts [--session KEY]` | List current Session drafts. |
| `qa-agent regression draft-show ID [--session KEY]` | Show a draft and its complete script. |
| `qa-agent regression publish --module MODULE --task TASK --draft ID --confirmed-by HUMAN` | Publish a separately reviewed script into the Task. |
| `qa-agent regression list --module MODULE --task TASK` | List formal Task scripts. |
| `qa-agent regression show ID --module MODULE --task TASK` | Show a formal script manifest. |
| `qa-agent regression run ID --module MODULE --task TASK [--bridge COMMAND]` | Run one formal Python script and generate a Runtime report. |
| `qa-agent task regression show|run TASK --module MODULE` | Show or run all validated scripts for one Task. |
| `qa-agent module regression show|run MODULE [--priority p0|p1|p2|p3]` | Show or run selected validated scripts for a Module. |

The formal Task assets are:

```text
regression/<script-id>.py
regression/<script-id>.json
regression-runs/<run-id>/...
```

## Release and archive

| Command | Purpose |
| --- | --- |
| `qa-agent impact analyze` | Resolve changed-file impact. |
| `qa-agent release check --profile fast|normal|full [--plan-only]` | Select and optionally run validated Python scripts for release. |
| `qa-agent release list` | List release checks. |
| `qa-agent release show CHECK_ID` | Show a release decision. |
| `qa-agent release report CHECK_ID` | Return the generated release report path. |
| `qa-agent archive --module MODULE --task TASK` | Archive only after Python coverage, evidence, Cleanup, and memory gates pass. |

## Session and administration

| Command | Purpose |
| --- | --- |
| `qa-agent session bind --module MODULE --task TASK` | Bind a Task to the current Session. |
| `qa-agent session current` | Show the active binding. |
| `qa-agent session clear` | Clear an explicit binding. |
| `qa-agent validate` | Validate project assets. |
| `qa-agent migrate` | Remove legacy replay assets and upgrade Python manifests. |
| `qa-agent index rebuild` | Rebuild project indexes. |
| `qa-agent skill validate` | Validate the installable three-Skill package. |

v0.3.3 uses one reusable execution model: approved Python scripts. Each Task has one current Source Run; publication freezes it, and `sourceFlowHash` traces the script to that exact completed business flow.
