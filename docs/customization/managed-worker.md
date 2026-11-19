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

已接入项目创建、管理权移交和文字待办派工。立项仍使用所有者命令；不会把复杂任务自动升级为项目。

1. 在未绑定项目的 **SuperAgent Studio Leader** 会话中提交 `/studio-project create {"name":"资料整理","objective":"持续整理研究记录"}`。回执给出项目 ID、Leader Bot、当前会话及管理轮次 `1`。可用 `leaderBotId` 复用已有 Leader Bot，用 `originTaskId` 引用一个已经完成的文字任务；引用原成果不重新派工。
2. 在当前 Leader 会话中用普通消息要求登记一项自包含的文字待办，将所需材料放在同一条消息里。登记保留原文与来源，不会启动 Worker。用 `/studio-project work` 可查看最近 20 项。需要执行时，让当前 Leader 派工指定待办 ID；Worker 沿用 Leader 当时选择的模型和思考深度，只接收该待办的原文，不能用工具或修改文档。
3. 用 `/studio-project work <待办ID>` 查看原请求、状态和 Worker 的原始结果，不调用模型。在同一项目的 Leader 会话中，Worker 结束或宿主重启后仍可取回已保存结果。已经开始的工作中断后会留下状态，不会自动重跑。
4. 要换管理会话，在从未绑定项目的 Leader 会话中提交 `/studio-project take <项目ID> <当前管理轮次>`。默认保留 Leader Bot；末尾可追加已有 Leader Bot ID 或 `new` 以换负责人。旧会话仍可读本项目记录，但不能再登记或派工。移交前尚未开始的保留名额会释放，由当前 Leader 决定是否继续原待办；已经开始的 Worker 可保存原出处的结果。

如果移交报轮次过时、命令重复，或回执不明，先在原 Leader 会话用 `/studio-project status` 核对当前会话和轮次，也可在新的 Leader 或 Studio Assistant 会话用 `/studio-project status <项目ID>` 查询。不要原样重发旧的移交命令。

## 文档写入控制

要替换已明确授权的文档，请在新的普通会话中选择 **SuperAgent managed document Worker**。不要在 Assistant、受托起草文字的 Worker、旧执行器或 DSH 子代理会话中登记这项授权。文档 Worker 使用只读沙箱，写入只能通过宿主注册的 `studio_write_document` 动作。

1. **登记一条确切授权。** 在 Worker 会话中提交 `/studio-doc start {"initial":"旧正文","replacement":"获准的新正文"}`。回执包含任务 ID、执行轮次、授权版本和文档版本。用 `/studio-doc continue <授权版本>` 让 Worker 提交这次修改。只有登记的新正文与预期文档版本 `1` 完全匹配时，动作才可能把文档更新到版本 `2`。普通聊天文本不增加权限。多个任务要修改同一文档时，按下文用文档 ID 绑定，不要分别用 `initial` 创建副本。
2. **暂停和查看状态。** 在当前 Worker 会话中提交 `/studio-doc pause`。收到 `Pause effective` 时，暂停与新授权版本已经提交。随时可用 `/studio-doc status` 查看状态，不会返回正文。若回执说暂停未保存，宿主仍阻止该任务写入，而且不提供可用的恢复版本；可重试暂停，或在宿主重启后重新打开会话查看状态。
3. **移交到新 Worker。** 新建一个尚未绑定任务的同预设会话，在那里提交 `/studio-doc transfer <任务ID> <当前执行轮次>`。移交保留已登记的文档内容范围和暂停状态；旧会话不能再写入。
4. **恢复暂停的任务。** 核对任务和写入范围后，在当前 Worker 会话中提交状态或移交回执给出的 `/studio-doc resume <授权版本>`；过时的版本不能恢复写入。收到 `Execution resumed` 只表示重新允许写入，不会重跑旧动作。用回执中的新版本执行 `/studio-doc continue <授权版本>`。

### 多个任务修改同一文档

在 **SuperAgent managed document Worker** 会话中，用 `/studio-doc doc-new {"text":"起始正文"}` 创建共享文档，回执给出文档 ID 和修订 `1`。这一步不创建任务，也不授予 Worker 写入权。`/studio-doc doc-read <文档ID> [修订号]` 可查看正文；省略修订号则读取当前版本。

- **让任务基于同一版本工作。** 在各自尚未绑定的文档 Worker 会话中提交 `/studio-doc start {"documentId":"<文档ID>","expectedVersion":1,"replacement":"该任务获准的新正文"}`，然后用回执中的授权版本继续。任务的基准修订不会随文档改动自动更新。
- **直接编辑。** 所有者可提交 `/studio-doc doc-save {"documentId":"<文档ID>","expectedVersion":1,"text":"人工修订"}`。只有文档仍在指定修订时才保存；该命令不恢复暂停任务，也不替它完成工作。
- **遇到冲突。** `/studio-doc status` 分别显示任务的基准修订和文档的当前修订。若另一任务或所有者先保存，旧任务返回 `SHARED_DOCUMENT_CONFLICT`，不会覆盖先保存的正文。用 `doc-read` 比较两个版本，再明确决定如何合并或授权新的修改。当前不自动合并、不自动更新任务的基准；旧写入不要原样重试。

旧任务仍使用各自的独立文档，不会迁移成共享文档。

### 普通消息待核对

在隔离 profile 的 Studio 宿主 `config` 中设置 `guiDocumentInbox: true`。该项默认关闭。开启后，向当前文档 Worker 发送新的普通消息时，只要文档尚未写入，宿主就在模型阅读前登记这条消息并阻止写入；已有授权的旧调用也不能提交。同一消息重复投递不会得到第二条记录。编辑队列或移除消息不会改写或撤回已登记的内容。

- **收件不等于更正生效。** 聊天仍会进入 Worker 的后续模型轮次，以宿主命令回执为准。用 `/studio-doc inbox` 查看最早的待核对消息和授权版本。若消息带附件或无法保留全文，回执只给来源引用，核对时需查看原会话。
- **核对后再决定。** 对照最早一条消息，提交 `/studio-doc review <指令ID> <授权版本> pause`，可将待核对状态落实为持久暂停。只有确认没有改变原写入范围时才使用 `unchanged`；它不会解除已有暂停或扩大授权。若还有待核对消息，写入、恢复和移交仍被阻止。核对或恢复不会自动重新执行已拒绝的动作。
- **登记结果不明时，不能按无待核对项处理。** `INSTRUCTION_UNCONFIRMED` 表示当前宿主继续阻止文档写入；恢复存储后重启，先核对原始聊天和文档状态，不直接重跑旧动作。关闭 `guiDocumentInbox` 不会清除已保存的待核对项。

### 缩小修改范围并继续原任务

如果要求只保留原先批准的部分修改，可在当前文档 Worker 处理，无须新建任务。系统不从聊天自动推断授权变化。

1. 用 `/studio-doc inbox` 核对最早的消息、来源和当前版本。若显示 **Approved changed lines**，复制回执中的 `/studio-doc narrow` 模板，把 `keepLines:[]` 换成要保留的行号，例如 `"keepLines":[1]`；其余字段照抄。行号从 `1` 开始，必须保留至少一行、但不能保留全部原批准变更。其他行恢复为起始正文。新增行、删除行、改换行格式，或根据标为迟到的飞书消息窄化，都不受支持；若不确定应保留哪些改动，先暂停。
2. **Scope narrowed** 表示新范围已保存，宿主会拒绝基于旧版授权的调用；这时文档尚未写入。若还有待核对消息，继续检查；若原任务已暂停，核对后显式恢复，窄化不会自动解除暂停。
3. 当前 Worker 空闲时，用回执中的 `/studio-doc continue <授权版本>` 继续。它把当前获准的准确正文发给同一 Worker，不授予新权限，也不会被再次登记为聊天更正。相同版本不会重复投递；若遇到中断，先核对状态，不把继续回执当作写入成功。实际写入以工具结果和 `/studio-doc status` 的文档版本为准。

原范围不能继续且无法用上述方式收紧时，可先用 `/studio-doc pause` 直接暂停，不必等待模型。

### 飞书私聊登记

飞书入口默认关闭，可在隔离 profile 的 Studio 宿主 `config` 中加以下配置。使用专供 Studio 的可信机器人 CLI，不把凭据写入配置。CLI 必须限制为 `bot` 身份；不要让原型的飞书 Source 同时消费这个机器人的事件。Studio 在连接前核对应用和机器人 ID，只收下面指定人发到指定私聊的消息，不接受群消息或机器人消息。

```yaml
feishuDocumentInbox:
  cli: /absolute/path/to/studio-lark-cli
  appId: cli_example
  botOpenId: ou_studiobot
  ownerOpenId: ou_studioowner
  chatId: oc_studiochat
```

1. 在文档 Worker 会话用 `/studio-doc feishu-status` 确认正在监听。在当前待写任务的 Worker 会话用 `/studio-doc bind-feishu` 绑定。绑定随任务保留，换 Worker 不改变归属；已经绑定的私聊和任务均不能改指到另一个对象。
2. 从指定私聊发送消息。未绑定时不猜任务；回执只确认消息已登记、文档写入暂被阻止，不代表新指令已经生效。若未收到回执，可在当前 Worker 会话用 `/studio-doc inbox` 核实，不必重发。飞书消息不会直接唤起 Worker 或启动工作。
3. GUI 和飞书共用同一待核对列表。相同飞书消息只登记一次；若发送时间早于同一私聊已登记消息，会标明可能乱序。两个渠道的时间不能直接比较，也不会按最后到达的消息改变确认过的范围。用前述命令核对原消息及来源，再决定是否暂停。

此入口只监听实时送到 CLI 的事件，不补收断线期间的历史，不提供通用飞书任务入口；已登记消息的阻断不依赖飞书连接仍在线。

## 宿主重启

受管入口在接收动作前，先把本次运行登记为未确认结束。只有停止接收动作且没有未确认的暂停或指令登记时，才登记为正常关闭。若保存失败后退出、进程异常退出，或首次打开缺少关闭记录的旧实验数据库，宿主无法从数据库判断哪些待写任务受影响。它在开放动作前暂停所有仍待写且未暂停的任务，提高其授权版本，并单独记录这些系统暂停。已提交的文档和已暂停的任务保持不变；若恢复事务也写不进去，受管入口不会启动。重启本身不会重新放行写入。

Studio 的 SQLite 状态只由一个宿主管理，不支持多个宿主共用状态目录或恢复已经回退的数据库。它不会自动接手 GitHub Ticket、迁移旧会话或启动长作业；飞书入口只登记已绑定文档的消息。
