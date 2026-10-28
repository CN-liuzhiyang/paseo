---
title: 定时任务
description: 按 cron 计划运行新的 Agent，或用 heartbeat 唤醒已有的 Agent。
nav: 概览
---

# 定时任务 {#schedules}

定时任务按 cron 节奏为你启动一个新的 Agent：在这个时间，在这个仓库里，用这些 Agent 设置运行这段提示词。

Paseo 还有 **heartbeat**。heartbeat 会定期向一个已有的 Agent 发送提示词，让它重新评估并继续同一段对话。

两者使用同一个 cron 引擎，但在产品中是分开的：

- **定时任务**每次运行都会创建一个新的 Agent。你可以查看、暂停、恢复、运行一次、更新或删除它们。
- **heartbeat** 针对一个已有的 Agent，刻意保持轻量：通过 MCP 创建或删除；在 CLI 中还可以只更新它们的 cron 周期。

cron 是标准的节奏表示。CLI 接受 `5m` 或 `1h` 这样的简单预设，但会把它们编译成 cron，而不是另存一种间隔类型。

定时任务还可以把每次运行的结果（包括失败的运行）投递到某个[插件](/docs/plugins/reference#outbound-channels)注册的出站渠道，例如团队聊天。在应用中，于定时任务的 **Deliver results** 字段按名称选择目的地；定时任务列表会显示结果投递到哪里，以及最近一次结果是否已送达。在 CLI 中，请参见[投递结果](/docs/schedules-cli#deliver-results)。

两者都按你设定的节奏运行。如果想由外部事件（比如一条评论或一次提及）启动 Agent，请参见 [Hub](/docs/hub)。

## 用途 {#what-its-for}

- **全新的周期性任务**：为每日分拣、报告或维护启动一个干净的 Agent。
- **heartbeat**：让当前 Agent 定期重新评估状态并继续推进。
- **盯构建**：让一个 Agent 持续检查 CI、EAS、Docker 或发布构建，直到通过。
- **每日分拣**：每天早上扫描 issue、PR 和失败的检查。
- **维护巡检**：更新依赖、审核文档或清理过期分支。

## 在一个工作区中运行 {#run-in-one-workspace}

默认情况下，每次运行都会创建自己的工作区。定时任务也可以改为在你已有的[工作区](/docs/workspaces)中运行，这样每次运行都会在其中启动一个新的 Agent，结果集中在同一个地方。

在应用中，先选择项目，再在 **Workspace** 字段中选择一个工作区。默认值是 **New workspace each run**。在 CLI 中传入 `--workspace`，见[在 CLI 中使用定时任务](/docs/schedules-cli#run-in-a-workspace)；通过 MCP 则传入 `workspaceId`。

要为定时任务准备一个空工作区，可以先不启动 Agent 来创建它：在应用中选择 **新建 workspace**，消息留空，然后创建；也可以运行 `paseo workspace create`。请在侧边栏中给它改名，这样你就能在 **Workspace** 字段中把它和其他工作区区分开。

在工作区中运行的定时任务，行为与自建工作区的定时任务不同：

- 它直接使用该工作区的目录，因此 worktree 隔离不适用。
- **Archive on finish** 只会归档本次运行的 Agent，工作区保持不变。应用中这类定时任务默认关闭该选项；通过 CLI 或 MCP 创建的定时任务则会在每次运行结束后归档。已归档的 Agent 不会作为标签页打开，但你可以在 **History** 中找到它，打开并取消归档。
- 选择普通工作区，而不是后台工作区。History 不会列出后台工作区中的 Agent，已归档的运行就很难找到。
- 如果工作区被归档或删除，定时任务会显示 **Target gone**。在下一次运行到期之前，请在定时任务的表单中选择另一个工作区。对于已归档的工作区，你还可以把它恢复：从 **History** 中打开该定时任务较早的一次运行，然后选择 **Restore**（如果工作区就是项目目录本身，则选择 **Unarchive**）。两种方式下，定时任务都会回到 **Active**。如果工作区仍不存在时又有一次运行到期，定时任务就会结束；已结束的定时任务无法通过编辑恢复，需要重新创建。

## 创建方式 {#ways-to-create-one}

- **在应用中**：打开定时任务视图，设置 Agent、cron 节奏、仓库和提示词来创建。这是创建和管理定时任务的主要方式。
- **[在聊天中](/docs/schedules-chat)**：在聊天中告诉 Agent，它会为你创建定时任务。
- **[通过 CLI](/docs/schedules-cli)**：`paseo schedule create`，适用于无界面的机器和脚本。
- **[通过 MCP](/docs/mcp)**：Agent 以编程方式创建和管理定时任务。

## 保留运行工作区 {#keep-run-workspaces}

新建 Agent 的定时任务每次运行都会创建一个工作区。**Archive on finish** 默认开启：运行结束时，Paseo 会归档该工作区及其 Agent。使用 worktree 隔离时，最后一个使用该 worktree 的活跃工作区被归档后，归档还会删除这个 worktree。

要保留运行结果，在应用的定时任务视图中打开该定时任务，关闭 **Archive on finish** 并保存。Paseo 会让每次运行的工作区和 Agent 保持活跃，直到你手动归档；在创建 Agent 之前就失败的运行仍会被清理。该选项同样适用于本地隔离；归档本地工作区不会删除项目目录。

存储的选项是 `target.config.archiveOnFinish`，一个布尔值，省略时默认为 `true`。CLI 和 MCP 的定时任务工具不提供这个选项；请在应用中修改。heartbeat 使用已有的 Agent，没有这个选项。
