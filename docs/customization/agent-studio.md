# 使用 Agent Studio

Agent Studio 是 DSH Web 左侧的独立入口。默认进入 **Assistant**，也可在项目列表选择活动项目，与它的现任 **Leader** 对话。各项目与 Assistant 分开保存对话；复用同一个 Leader Bot 也不会合并项目上下文。本指南说明当前阶段 1 的能力，不是 [V1 全部规格](requirements/v1-scope.md)的完成清单。

## 启用

使用仅监听回环地址、单所有者且未启用 LiveShare 的 DSH Web。已在 DSH `0.2.2-rc.5` 的隔离配置档验证。Studio 使用 DSH Web 自带的所有者浏览器登录，不需要另外配置 Web Token；不要将该监听地址暴露到公网。

从源码试用时，先在仓库运行 `pnpm build`。将以下覆盖层保存到仓库外，替换 `stateDir` 为此 Studio 实例专用的绝对目录。示例禁用同一 bundle 的 GitHub Ticket 条目，仅用于隔离试用；已有 Ticket 实例不需要改动。

```yaml
- id: agent-studio
  disabled: true
- id: agent-studio-github
  disabled: true
- id: agent-studio-feishu
  disabled: true
- id: agent-studio-worker-preset
  disabled: true
- id: agent-studio-router-preset
  disabled: true
- id: agent-studio-managed-worker
  disabled: false
  config:
    stateDir: /home/me/.dsh/agent-studio-test-state
- id: agent-studio-assistant-preset
  disabled: false
- id: agent-studio-leader-preset
  disabled: false
- id: agent-studio-managed-worker-preset
  disabled: false
```

用独立的 `DSH_HOME` 从试用目录启动，先加载[仓库补丁](../../cordis.patch.yml)，再应用覆盖层。打开本次启动输出的回环地址。

```sh
DSH_HOME=/absolute/path/to/studio-test-home dsh --profile web \
  --patch /absolute/path/to/agent-studio/cordis.patch.yml \
  --patch /absolute/path/to/studio-local.yml \
  --host 127.0.0.1 --port 0 --no-open
```

如该 bundle 已安装到隔离配置档，只需应用覆盖层，不重复加载仓库补丁。`studioCwd` 可指定已存在的绝对目录；省略时使用宿主工作目录。它不移动已有 Session，也不授权 Worker 改动文件。

## 从旧版升级

先停止旧宿主接收新工作，等待在途轮次结束，再停用旧 bundle。用 SQLite 备份接口把 `managed-worker.sqlite` 完整复制到新目录，核对副本完整性，然后让当前版本的 `stateDir` 指向副本。不要复制仍由旧宿主持锁的主文件，不要同时运行两个副本。保留原库、旧配置档和旧安装包，供核对或回退；不要用旧程序打开已迁移的库。

首次打开旧库时，宿主将 SQLite 迁移到 V1。已发布对话、对话模型设置和飞书绑定分界保留；普通已完成结果可查，旧在途执行标记为中断，不会自动重跑。旧 Session 仅供查阅，不恢复为可执行身份；受保护结果不会进入现行任务与交付投影。SQLite 迁移不搬运 DSH 会话日志或本地工作文件。旧 `textWorkerRoutes` / `textWorkerDefaults` 只用于读取兼容，应用设置时写回新键；旧飞书收件配置不会替你启用共用对话，需要用户重新明确验证绑定。

## 对话、项目和任务

| 角色 | 当前职责与限制 |
| --- | --- |
| **Assistant** | 回答普通问题，查项目和任务，提出需要所有者确认的立项建议，或把当前请求原文登记为独立的后台任务。 |
| **Leader** | 在本项目组织工作、派工和查询成果；项目换任或归档后，原任 Session 不再拥有管理权。 |
| **Worker** | 仅处理经过登记的当前任务，交付文字结果。阶段 1 没有通用文件读取、写入、shell 或转委派工具，也不运行本地检查。 |

- **发送**写入当前对话，不必先选择底层 Session。Assistant 委派后台任务或等候确认时仍可接收其他请求。任务登记不等于交付；结果返回原消息或话题。**引用**附带可跳回的原文片段，不新建话题；**回复**建立或接续以原消息为根的话题。
- 可用明确的任务名称、ID 或原消息回复指明要停止的工作；另问一件事不会自动取消旧任务。停止或重新交办不会撤回已经发生的动作，也不会自动重跑旧执行。
- 当前可通过原生命令 `/studio-project` 管理项目和档案、用 `/studio-memory` 明确登记或忘记偏好，用 `/studio-result <task-id>` 查询已存任务状态和结果。项目目标可修订；工作区变化、换任或归档会撤销旧在途执行。归档后不再接受新项目工作，既有数据保留；重开不恢复旧授权。现任 Leader 只能读取自己项目范围内的任务。专用任务列表与详情，以及从统一对话指名转交给现有项目，仍是后续工作。
- **会话记录**可按 Session ID、项目 ID 或角色查找；消息和已交付文字结果可用「查看来源」核对对应日志。读取不会唤醒会话或提交消息。Studio 管理的 Session 从浏览器普通工作区列表隐藏，原生存储和索引仍保留；该过滤不是对 DSH 全局搜索结果的承诺。

## Studio 设置

从 **Agent Studio → Studio 设置** 打开。设置作用于当前 DSH Web 配置档，不是单项目配置。跨分类编辑保留草稿；离开前可选择继续编辑或放弃。如果当前配置档不可写、修订已过期，或更高优先级的配置覆盖了相同字段，Studio 不会报告应用成功。

| 分类 | 可配置内容 | 生效方式 |
| --- | --- | --- |
| 对话模型 | Assistant、Leader 各自的默认提供方、模型和思考深度，也可用 DSH 默认 | 即时保存，用于后续轮次，不改变 Worker 路由。 |
| Worker 派工 | 带唯一 ID 的模型路由（`workerModelRoutes`）、按发起角色指定默认路由 ID（`workerModelDefaults`），以及 `defaultWorkerPermission` | 未设角色默认时先匹配对话模型，再选清单首项；清单为空则用对话模型。`read-only` / `workspace-write` 是任务记录的权限档位，后者在本阶段也不开放文件或 shell 工具。 |
| 飞书 | 停用，或绑定专用机器人私聊、共用 Assistant 对话 | 私聊验证与保存分开。设置已应用不等于已连通或单条消息已送达。 |
| 高级 | 新 Assistant Session 的工作目录、尚未保存对话模型时的初始值、Studio 数据目录 | 工作目录不移动现有 Session；初始值不覆盖已保存的模型；更换数据目录须另行确认。 |

除「对话模型」即时保存外，其余配置使用**检查并应用设置**，可能重载 Studio 宿主并重新连接飞书，不需要重启整个 DSH Web。在途工作会阻止重载。回执不明确时，先用「核对当前设置」读取实际值，不要重复提交。

### 更换 Studio 数据目录

在「高级」中填写一个**尚不存在**的绝对目标目录；其上级目录必须已存在，不经符号链接，不可由其他用户写入。选择**复制当前 Studio 数据库**或**使用空的 Studio 数据库**，再原样输入路径确认。复制保留 Studio 数据并留存原库；空库不导入历史，两种方式均不移动 DSH 会话日志或工作文件。若切换未确认，先核对实际路径，不要复用可能只准备了一部分的目标目录，也不要让新旧两份账本并行运行。

## 绑定飞书 Assistant 私聊（可选）

1. 在飞书开放平台准备专用自建应用与机器人，启用长连接、`im.message.receive_v1` 和 `card.action.trigger`，开通所需的私聊收发、回复和卡片更新权限后发布。同一应用不要同时让多个宿主接收长连接事件。
2. 点 **配置飞书** 或进入 **Studio 设置 → 飞书**，选择共用 Assistant 对话。填写应用 ID 和 App Secret，点 **验证私聊**；按提示在机器人私聊原样发送一次性验证消息。验证会核对机器人、操作者和私聊 ID；验证消息不会进入对话或触发派工。
3. 点 **检查并应用设置**，然后查看连接状态。App Secret 只写入 DSH 凭据存储，不回显；不要写入普通设置、日志或聊天。轮换密钥时先输入新值并验证再应用。解绑后停止新同步，不撤回已发的飞书消息，也不删除 Studio 记录。

同一绑定断线重连不改变初始时间分界，解绑或换绑后重新划界；不导入绑定前或补捞断线期间的飞书历史。不能确认的出站记录标为「未确认」，不会盲目重发。私聊验证只证明入站身份和路径；投递和卡片权限以实际结果为准。

共用对话只同步 **Assistant** 的文字消息、话题和支持的确认。GUI 用户消息以机器人身份标注「你 · 来自 GUI」，飞书来信在 GUI 标出来源；Leader 和 Worker 的内部消息及日志不向飞书同步。

## 待我处理

徽标只统计需要所有者处理的事项，不统计普通提问或 Session 活动。支持移动端的确认在飞书私聊主聊天提示；阶段 1 的部分事项（如任务阻塞）仍须在 Web 处理。Web 与飞书可问「还有什么待我处理？」核对状态，不调用模型。

对支持文字确认的事项，可直接回复对应消息说「批准」或「拒绝」，或明确说出要批准的立项。单独发「好」、指向不清或已失效的答复不能授权。批准只影响对应事项，不等于动作已执行。一端处理后，另一端读取同一状态；若飞书卡片更新不明确，可用文字查询。飞书客户端显示「已发送」不等于 Studio 已受理或执行。
