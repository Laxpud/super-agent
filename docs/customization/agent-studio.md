# 使用 Agent Studio

Agent Studio 是 DSH Web 左侧独立入口，不是普通工作区。打开后默认进入 **Assistant**，可从项目列表切到当前 **Leader**。Assistant 和各个项目分别保存对话；同一个 Leader Bot 管理两个项目，也不会合并它们的上下文。

## 启用

在仅监听回环地址、单所有者且未启用 LiveShare 的 DSH Web 中使用。以 DSH `0.2.2-rc.5` 为基准，先在源码树执行 `pnpm build`，再按[隔离环境启动方式](managed-worker.md#在隔离环境启用)启用 Studio 宿主和三个预设。`stateDir` 必须是该 Studio 实例专用的绝对路径。原型按既有方式单独启用；试用 Studio 时可保持原型条目关闭。

GUI 使用 DSH 的所有者浏览器登录，不需额外的 Web Token。默认用宿主工作目录建立新的 Assistant Session，可用 `studioCwd` 指定绝对路径。不要将 DSH Web 暴露到公网。

## 对话、话题与来源

- **发送**写入当前 Assistant 或项目对话。无需选择底层 Session。Studio 重用可用的 Session；Assistant 原 Session 已不存在时建立新 Session，项目交接后后续新消息交给当前 Leader。之前的对话仍在原处。
- **引用**附带原文片段，点击引用可跳回原消息，不创建话题。**回复**建立或接续以原消息为根的话题；点击主线上的回复入口即可回看话题，不展开进主时间线。
- 在原任务的话题中明确要求修改已完成的普通文字成果，Studio 在原任务下保存修订，由按原派工策略选定的无工具 Worker 执行。受管文档、长作业和带受保护证据的结果不走普通文字修订，也不会被自动当成新任务派工。
- **会话记录**可按 Session ID、项目 ID 或角色查找底层记录；消息和文字成果也可以通过「查看来源」直接查看对应事件。读取只打开日志，不唤醒角色、不提交消息，也不离开 Studio。

Studio 分配的底层 Session 不出现在浏览器普通工作区列表；Studio 宿主已登记的原生角色也按已绑定的身份排除，而不是按名称过滤。底层存储和 DSH 的 Session 索引保留。`0.2.2-rc.5` 没有 Workspaces 专用过滤接口，因此 Studio 在浏览器 Session 目录发布时过滤；原生全局内容搜索仍可能先受宿主返回条数限制。

## 模型设置

在 Studio 设置中分别选 Assistant、Leader 的默认 **Provider / 模型 / 思考深度**。保存时和每次发送前都会核对明确选定的组合。选「DSH 默认」则跟随宿主默认；未指定思考深度时按该模型的适配器默认。保存影响后续轮次，不打断正在运行的轮次；对话窗口没有临时模型切换。Worker 继续使用[派工模型配置](managed-worker.md#限定普通文字-worker-的模型组合)，不会被 Studio 对话设置直接覆盖。

## 绑定飞书 Assistant 私聊（可选）

准备一个独立的自建应用与机器人，在飞书配置长连接接收 `im.message.receive_v1` 和「卡片回传交互」`card.action.trigger`，开通以机器人身份发送、回复私聊与更新消息卡片所需的权限。验证机器人、操作者和私聊 ID 后，在 Studio 宿主条目 `dsh-superagent-managed-worker` 的 `config` 下填写下列字段；不用同时启用旧的 `feishuTextInbox` 或 `feishuDocumentInbox`。

```yaml
studioCwd: /absolute/path/to/workspace
feishuConversation:
  appId: cli_<app-id>
  botOpenId: ou_<bot-open-id>
  ownerOpenId: ou_<owner-open-id>
  chatId: oc_<private-chat-id>
```

启动时从宿主环境提供 `STUDIO_FEISHU_APP_SECRET`；不要保存到配置、日志或聊天。Studio 在实际验证机器人并建立长连接后记录绑定时间；同一绑定断线重连不会更换时间分界。解除、改变绑定并再次连接时重新划界，不导入绑定前的对话，也不执行旧消息。重启没有补捞断线期间的飞书历史；若发送回执无法确认，Studio 标为「未确认」，不会盲目重发。

两端共用 **Assistant** 的文字消息和话题。GUI 的用户消息以机器人身份同步，标作「你 · 来自 GUI」；飞书来信在 GUI 标出来源。GUI 中回复、在飞书原消息的话题中继续，或反过来，都会关联同一个话题。Leader、Worker 的内部消息和日志不会同步到飞书。

## 待我处理

入口徽标只统计需要你处理的事项。Studio 中可定位对应的对话或任务，填写答复，或选择具体的确认项；不会因为底层 Session 活动增加徽标。飞书绑定后可以直接问「还有什么待我处理？」，不调用模型。对能处理的文字问题，在原卡片的话题里直接回复卡片；对已支持的确认（例如立项）使用对应的卡片按钮。选择只对具体、仍有效的事项生效；单独发「好」、旧卡片重按或跨事项选择均不等于批准。未开放手机确认的事项显示「仍待确认」，在 Studio 核对后按原权限流程处理。

一端处理后，另一端读取同一状态。飞书由机器人更新原卡片；如果宿主离线或更新未获飞书确认，旧卡片的外观可能还没变，但重复选不能再次生效。宿主需持续运行并能连接飞书；不要求浏览器一直打开。关机、休眠或断网期间不能实时处理，飞书客户端显示「已发送」不代表 Studio 已接收或执行。
