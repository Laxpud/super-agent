# SuperAgent Studio：文字任务、项目与受管文档

Studio 可以把独立的文字任务交给 Worker，并保存其原文供用户取回。用户还可以建立独立于仓库的项目，选择当前管理会话并登记待办。受管文档入口只允许替换数据库里已明确授权的正文。Studio 不接管 GitHub Ticket，也不能写普通工作区文件。Studio 宿主和配套预设默认关闭；原型的 GitHub、飞书和执行器预设维持原有行为。

## 在隔离环境启用

使用 DSH `0.2.2-rc.3` 的单所有者 Web 环境，以回环地址监听。不要给该环境配置 LiveShare、远程入口、共享所有者登录或非所有者的命令和会话写权限。操作员通过 DSH Web 自己的所有者认证；原生命令回调不另外识别自然人身份。不要把它部署到当前工作的 profile 里试用。

下面的覆盖层适用于已经在隔离 profile 中安装本 bundle 的情况，此时 [bundle 补丁](../../cordis.patch.yml) 已提供这些条目。若只用源码树做开发验证，可用进程级 `--patch` 加载 bundle 补丁，并新增一个指向本地构建入口 `lib/managed-worker.js` 的临时 Host 条目；不要同时启用依赖包名解析的条目。`stateDir` 必须是受管入口专用的绝对目录，不应与旧执行器、其他实例或 Worker 工作目录共享。

```yaml
- id: dsh-superagent
  disabled: true
- id: dsh-superagent-github
  disabled: true
- id: dsh-superagent-feishu
  disabled: true
- id: dsh-superagent-worker-preset
  disabled: true
- id: dsh-superagent-router-preset
  disabled: true
- id: dsh-superagent-managed-worker
  disabled: false
  config:
    stateDir: /absolute/path/to/managed-worker-state
- id: dsh-superagent-managed-worker-preset
  disabled: false
- id: dsh-superagent-studio-assistant-preset
  disabled: false
- id: dsh-superagent-studio-leader-preset
  disabled: false
```

## 交代文字任务和取回成果

1. 在新会话中选择 **SuperAgent Studio Assistant**，选择支持工具调用的模型，用普通消息提出一个独立的纯文字任务，例如「把这三条材料整理成一个简短比较表」。当前只转交该条请求，不自动带上过去的聊天、附件或文件；请把所需文字放在同一条消息。Worker 沿用 Assistant 当时选择的模型和思考深度，不具备业务工具。
2. 在原会话展开 **Worker result** 工具卡片，看 Worker 的原文和任务 ID。宿主同时保存产出 Bot、会话、执行轮次与消息位置。Assistant 可以报告任务状态，但卡片中的原文不靠它复述。
3. 在这个会话用 `/studio-result` 取回最新任务，或在任意 Studio Assistant 会话用 `/studio-result <任务ID>` 取回指定任务。此命令不调用模型，不需要 Worker 在线。宿主重启后，已经保存的成果仍可读；未完成的任务显示为中断，不自动再派一遍。

文字请求和结果各限 32,000 个 UTF-16 代码单元。三分钟内未完成时，宿主会请求取消 Worker，再关闭其会话。超时、失败或没有完整文字时，不把中间内容当作完成。文字任务不授予任何文档写入权，也不用于运行外部长作业。

## 建立项目与移交管理权

已接入项目创建、管理权移交和待办登记。当前用明确的所有者命令操作项目；还不能用普通聊天立项，也不会把复杂任务自动升级为项目。

1. 在未绑定项目的 **SuperAgent Studio Leader** 会话中提交 `/studio-project create {"name":"资料整理","objective":"持续整理研究记录"}`。回执给出项目 ID、Leader Bot、当前会话及管理轮次 `1`。可用 `leaderBotId` 复用已有 Leader Bot，用 `originTaskId` 引用一个已经完成的文字任务；引用原成果不重新派工。
2. 在当前 Leader 会话中用普通消息明确要求登记一项待办。Leader 工具将原始请求与来源一起保存；看到工具回执中的待办 ID 才算登记。这一步不启动 Worker，也不授权文档写入或外部操作。用 `/studio-project status` 查看当前归属、目标和待办数，目前不列出待办明细。
3. 要换管理会话，在从未绑定项目的 Leader 会话中提交 `/studio-project take <项目ID> <当前管理轮次>`。默认保留 Leader Bot；末尾可追加已有 Leader Bot ID 或 `new` 以换负责人。回执给出新管理轮次。旧会话仍能查看项目，但不能登记新待办，也不能重新接管。

如果移交报轮次过时、命令重复，或回执不明，先在原 Leader 会话用 `/studio-project status` 核对当前会话和轮次，也可在新的 Leader 或 Studio Assistant 会话用 `/studio-project status <项目ID>` 查询。不要原样重发旧的移交命令。

## 文档写入控制

要替换已明确授权的文档，请在新的普通会话中选择 **SuperAgent managed document Worker**。不要在 Assistant、受托起草文字的 Worker、旧执行器或 DSH 子代理会话中登记这项授权。文档 Worker 使用只读沙箱，写入只能通过宿主注册的 `studio_write_document` 动作。

1. **登记一条确切授权。** 在 Worker 会话中提交 `/studio-doc start {"initial":"旧正文","replacement":"获准的新正文"}`。回执包含任务 ID、执行轮次、授权版本和文档版本。之后可用普通消息安排 Worker 提交这次修改。只有登记的新正文与预期文档版本 `1` 完全匹配时，动作才可能把文档更新到版本 `2`。普通聊天文本不增加权限。
2. **暂停和查看状态。** 在当前 Worker 会话中提交 `/studio-doc pause`。收到 `Pause effective` 时，暂停与新授权版本已经提交。随时可用 `/studio-doc status` 查看状态，不会返回正文。若回执说暂停未保存，宿主仍阻止该任务写入，而且不提供可用的恢复版本；可重试暂停，或在宿主重启后重新打开会话查看状态。
3. **移交到新 Worker。** 新建一个尚未绑定任务的同预设会话，在那里提交 `/studio-doc transfer <任务ID> <当前执行轮次>`。移交保留已登记的文档内容范围和暂停状态；旧会话不能再写入。
4. **恢复暂停的任务。** 核对任务和写入范围后，在当前 Worker 会话中提交状态或移交回执给出的 `/studio-doc resume <授权版本>`；过时的版本不能恢复写入。收到 `Execution resumed` 只表示重新允许写入，不会自动重跑动作。如果原动作已被拒绝，还要用普通消息让 Worker 继续。

## 宿主重启

受管入口在接收动作前，先把本次运行登记为未确认结束。只有停止接收动作且没有未确认的暂停时，才登记为正常关闭。若暂停保存失败后退出、进程异常退出，或首次打开缺少关闭记录的旧实验数据库，宿主无法从数据库判断哪些待写任务受影响。它在开放动作前暂停所有仍待写且未暂停的任务，提高其授权版本，并单独记录这些系统暂停。已提交的文档和已暂停的任务保持不变；若恢复事务也写不进去，受管入口不会启动。重启本身不会重新放行写入。

Studio 的 SQLite 状态只由一个宿主管理，不支持多个宿主共用状态目录或恢复已经回退的数据库。它不会主动从 GitHub 或飞书接单，不自动迁移旧会话，也不启动长作业。
