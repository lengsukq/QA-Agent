# QA Agent CLI Command Reference

Use CLI commands for all project mutations. The Agent must not create Task JSON, Scenario files, reports, or OperationPlans by hand.

| Command | Purpose | Starts a UI Run? |
| --- | --- | --- |
| `qa-agent init --codex --cursor` | Initialize `.qa-agent/` and inject selected project hosts. | No |
| `qa-agent update [--force] [--migrate]` | Sync prompts, Skills, host templates, and project metadata. | No |
| `qa-agent start --request TEXT --module MODULE --task TASK` | Atomically create the complete Task package and stop at approval. | No |
| `qa-agent task review TASK --module MODULE --approve --confirmed-by HUMAN` | Persist human approval only. | No |
| `qa-agent test --module MODULE --task TASK` | Start first Explore or compatible OperationPlan replay. | Yes when Runtime allows it |
| `qa-agent operation generate --module MODULE --task TASK --run RUN_ID` | Explicitly generate a quick-regression OperationPlan candidate from a completed successful exploratory Run. | No |
| `qa-agent task operation list/show/review ...` | Inspect and approve OperationPlan candidates. | No |
| `qa-agent task regression sync/run/complete ...` | Build or execute Task regression suites. | `run` starts child Runs |
| `qa-agent archive --module MODULE --task TASK` | Validate and archive complete Task assets. | No |
| `qa-agent prompts sync` | Synchronize the current five project prompts and remove obsolete prompts. | No |
