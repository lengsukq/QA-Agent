# QA Agent CLI Command Reference

Use CLI commands for all project mutations. The Agent must not create Task JSON, Scenario files, reports, events, indexes, or OperationPlans by hand.

| Command | Purpose | Starts a UI Run? |
| --- | --- | --- |
| `qa-agent init --codex --cursor` | Initialize `.qa-agent/` and inject selected project hosts. | No |
| `qa-agent update [--force] [--migrate]` | Sync prompts, Skills, host templates, schemas, and migrate legacy lifecycle assets. | No |
| `qa-agent start --request TEXT --module MODULE --task TASK` | Create or resume the complete Task package and stop at TestPlan approval. | No |
| `qa-agent review --module MODULE --task TASK --approve --confirmed-by HUMAN` | Persist explicit TestPlan approval only. | No |
| `qa-agent test --module MODULE --task TASK [--scenario SCENARIO]` | Start Explore or compatible OperationPlan Replay. | Yes when Runtime allows it |
| `qa-agent task operation list/show/review ...` | Inspect and promote Runtime-generated OperationPlan candidates. | No |
| `qa-agent task regression sync/run/complete ...` | Build or execute validated Task regression suites. | `run` starts child Runs |
| `qa-agent archive --module MODULE --task TASK` | Validate and archive complete Task assets. | No |
| `qa-agent prompts sync` | Synchronize all current phase prompts and remove obsolete prompts. | No |
| `qa-agent validate` | Validate Task assets, Scenarios, Runs, reports, OperationPlans, events, and indexes. | No |

`workflow bootstrap`, `task explore`, `task run`, `operation replay`, `operation generate`, `task review`, and `task archive` are compatibility or repair commands. Canonical `nextActions` never select them for a new conversation.
