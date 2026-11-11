---
title: 在 CLI 中使用定时任务
description: 用 paseo schedule 创建和管理 Paseo 定时任务。
nav: CLI
---

# 在 CLI 中使用定时任务 {#schedules-from-the-cli}

`paseo schedule` 在终端中创建和管理[定时任务](/docs/schedules)，适用于无界面的机器和脚本。Agent 定时任务每次运行都会启动新的 Agent；插件自动化也可以执行已注册的动作。

默认情况下，每次运行结束时都会归档其工作区。CLI 没有 **Archive on finish** 参数；要让之后的运行工作区保持活跃，请[在应用中修改该选项](/docs/schedules#keep-run-workspaces)。

## 项目来源 {#project-sources}

在项目 `paseo.json` 的 `automations` 对象中定义自动化。键匹配 `[a-z][a-z0-9-]*`；定义包含 `prompt`、`target`、`triggers`（every/cron/event，最多一个时钟）。仓库 delivery 只能填 channel。Git 项目读取默认分支已提交文件的本地引用；启动、每十分钟或手动扫描时读取。

用 `paseo automation source ls|scan` 发现来源，`source show <id>` 查看定义，再用 `source set <id> --deliver chat:me --provider codex/model --param key=value` 设置本机覆盖。用 `source enable <id> --fingerprint <sha256>` 批准：需要直连人类会话及 `daemon.manage`，中继和插件不能批准。set 同样需要 `daemon.manage`，其它操作需要 `automation.manage`。

定义变化后暂停，重新批准才恢复；show 展示当前/批准定义和覆盖。参数浅合并。`source disable <id>` 暂停；`source forget <id>` 删除本机来源和生成的计划。定义消失时记为 orphaned，保留历史。普通 update/resume 不能修改来源计划。缺少动作或事件插件时 ERROR 列显示缺少插件，不能批准。宿主必须支持 `features.automationSources`。

## 插件自动化 {#plugin-automations}

`paseo automation` 是 `paseo schedule` 同一命令树的别名。新参数要求宿主声明
features.automations，旧宿主会被明确拒绝。App 对这些定义只读显示；原有代理计划仍可编辑。

```bash
paseo automation actions --json
paseo automation triggers --json
paseo automation create "回显事件" --on demo:ping,sender=alice \
  --action demo.echo --param text=hi --timeout 5m --deliver demo-results:example
paseo automation update <id> --on demo:ping --param text=updated
paseo automation update <id> --clear-on --no-clock
paseo automation run-once <id> --event-json '{"id":"test","event":"ping","data":{"text":"hello"}}'
paseo automation logs <id>
```

可重复使用 --on source:event[,k=v...]；--every 或 --cron 额外添加一个时钟触发。
只有 --on 时创建 cadence:none。update 整体替换事件列表，--clear-on 清空列表，
--no-clock 移除时钟；没有任何触发时仍可手动运行。

--action 与 provider、mode、thinking、workspace、cwd 等代理目标参数互斥。
重复 --param k=v 或用 --params-json 传嵌套对象；param 覆盖 JSON 对象中的同名键。
未加引号的数字和布尔值保留类型。参数选项会整体替换参数对象；只改 --action 或 --timeout
会保留其他动作字段。--timeout 最多 60 分钟。
actions/triggers 可发现已注册动作、参数模式和事件源。列表和详情显示触发与动作，
日志显示触发来源和合并数。手动事件测试不参与去重。

事件运行不推进时钟，并遵守运行次数和到期限制；手动运行沿用上游行为，
不会使计划完成或推进时钟。
限流暂停可在 PauseReason 看到；处理原因后用 resume 恢复。
重放、合并、防环和入口限流见[事件契约](/docs/plugins/reference#automation-actions-and-events)。

旧客户端会隐藏动作目标和无时钟记录，其余记录收到兼容投影。降级 daemon 前备份状态：
旧 daemon 会跳过动作/无时钟文件，但重写其他兼容记录时可能丢掉事件触发字段。

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
