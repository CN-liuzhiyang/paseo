---
title: 在 CLI 中使用定时任务
description: 用 paseo schedule 创建和管理 Paseo 定时任务。
nav: CLI
---

# 在 CLI 中使用定时任务 {#schedules-from-the-cli}

`paseo schedule` 在终端中创建和管理新建 Agent 的[定时任务](/docs/schedules)，适用于无界面的机器和脚本。每次运行都会启动一个新的 Agent。

默认情况下，每次运行结束时都会归档其工作区。CLI 没有 **Archive on finish** 参数；要让之后的运行工作区保持活跃，请[在应用中修改该选项](/docs/schedules#keep-run-workspaces)。

## 创建 {#create}

在 Codex 上通宵重构：

```bash
paseo schedule create \
  --every 30m \
  --name overnight-refactor \
  --provider codex/gpt-5.5 \
  --cwd ~/dev/my-app \
  --max-runs 16 \
  --expires-in 10h \
  "Continue the refactor. Run the focused checks. Leave a short status note."
```

在 Claude 上看护耗时较长的构建：

```bash
paseo schedule create \
  --every 5m \
  --name build-watch \
  --provider claude/opus-4.7 \
  --cwd ~/dev/my-app \
  --max-runs 24 \
  "Check the release build. If it failed, inspect logs, fix the cause, and rerun."
```

通过 OpenCode 使用 GLM 每天分拣 GitHub：

```bash
paseo schedule create \
  --cron "0 14 * * 1-5" \
  --timezone UTC \
  --run-now \
  --name github-triage \
  --provider opencode/openrouter/glm-5.1 \
  --cwd ~/dev/my-app \
  "Triage GitHub issues, PRs, and failing checks. Summarize what needs attention."
```

纽约时间早上 9 点进行晨间分拣，并跟随夏令时变化：

```bash
paseo schedule create \
  --cron "0 9 * * 1-5" \
  --timezone America/New_York \
  --name morning-triage \
  --provider codex/gpt-5.5 \
  --cwd ~/dev/my-app \
  "Review overnight CI failures and summarize anything urgent."
```

## 在工作区中运行 {#run-in-a-workspace}

`--workspace <id>` 会让每次执行都在你已有的工作区中进行，而不是为每次运行各建一个工作区。定时任务使用该工作区的目录，因此省略 `--cwd`；使用 `--host` 时，`--workspace` 同样替代 `--cwd`。

```bash
paseo workspace create --isolation local --path ~/dev/my-app --title "Weekly report"
paseo workspace ls
paseo schedule create \
  --cron "0 9 * * 1" \
  --name weekly-report \
  --provider codex/gpt-5.5 \
  --workspace <workspace-id> \
  "Write the weekly report and leave it in docs/reports."
```

`paseo schedule ls` 会在单独的一列中显示工作区。之后要修改时：

```bash
paseo schedule update <id> --workspace <other-workspace-id>
paseo schedule update <id> --no-workspace
```

`--no-workspace` 会切换回每次运行创建一个新工作区，并保留定时任务当前的工作目录，也就是旧工作区的目录。要在同一条命令中修改它，请加上 `--cwd`。

请使用普通工作区，而不是后台工作区；归档行为以及工作区缺失时的情况，见[在一个工作区中运行](/docs/schedules#run-in-one-workspace)。主机必须支持此功能，否则命令会失败，并提示你更新主机。

## heartbeat {#heartbeats}

在一个正在运行的 Paseo Agent 中，为同一段对话创建 heartbeat：

```bash
paseo heartbeat create \
  --cron "*/20 * * * *" \
  --name heartbeat \
  "Check the current task state and continue with the next useful step."
```

heartbeat 的接口有意保持精简：

```bash
paseo heartbeat update <id> --cron "*/10 * * * *"
paseo heartbeat delete <id>
```

更新 heartbeat 只会改变它的 cron 节奏和可选的时区。它的目标和提示词保持不变。heartbeat 命令需要 `PASEO_AGENT_ID`，Paseo 会在 Agent 会话中设置它。

heartbeat 需要原始的 `--cron` 表达式。下文的 `--every` 预设只适用于新建 Agent 的定时任务。

## 管理 {#manage}

```bash
paseo schedule ls
paseo schedule inspect <id>
paseo schedule logs <id>
paseo schedule pause <id>
paseo schedule resume <id>
paseo schedule run-once <id>
paseo schedule update <id> --every 10m --max-runs 6
paseo schedule delete <id>
```

## 投递结果 {#deliver-results}

插件可以注册出站渠道，例如聊天集成。用 `--deliver <channel:to>` 把定时任务指向它，每次运行的结果（包括失败的运行）都会发到那里：

```bash
paseo schedule create --cron "0 9 * * 1-5" --name standup \
  --deliver chat:general \
  "Summarize yesterday's merged PRs."
paseo schedule update <id> --deliver chat:releases
paseo schedule update <id> --no-deliver
```

第一个 `:` 之前的文本是渠道 ID，其余部分是只有该渠道能解释的地址。`paseo schedule channels` 会列出正在运行的插件提供的渠道，以及每个渠道给出的目的地，并显示应传入的 `to`：

```bash
paseo schedule channels
# CHANNEL  LABEL      DESTINATION  TO
# chat     Team chat  General      general
# chat     Team chat  Releases     releases
```

无法列出目的地的渠道会显示 `(unavailable: <error>)`。创建定时任务时不会检查该渠道。`schedule inspect` 会显示投递目标，`schedule logs` 会显示每次运行的投递状态。投递失败会记录在该次运行上，但不会改变运行本身的状态；Paseo 不会重试。

## 节奏 {#cadence}

使用 `--cron "<expr>"` 指定 5 字段的 cron 表达式。对于常见的、可用 cron 表示的节奏，`--every <duration>` 接受 `5m` 或 `1h` 这样的预设，并把它们编译为 cron。它不会创建以创建时间为起点的滚动间隔。

定时任务默认使用 UTC。传入 `--timezone <IANA>` 可以按本地挂钟时区解释 cron 字段，例如 `--timezone America/New_York`。持久化的 `nextRunAt` 仍然是 UTC 时刻，但它是按该本地时区计算的，因此重复任务在夏令时变化前后都保持在相同的本地时间。

定时任务默认等待下一个匹配的 cron 时间。传入 `--run-now` 可以在创建时立即运行一次。

以远程 daemon 为目标时，用 `paseo --host <target> schedule create ...` 开始命令。请传入 `--cwd`；你本地的工作目录在远程机器上可能不存在。
