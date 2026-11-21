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

1. 在新会话中选择 **SuperAgent Studio Assistant**，选择支持工具调用的模型，用普通消息提出一个独立的纯文字任务，例如「把这三条材料整理成一个简短比较表」。当前只转交该条请求，不自动带上过去的聊天、附件或文件；请把所需文字放在同一条消息。Worker 不具备业务工具，其模型按[文字派工配置](<#限定普通文字-worker-的模型组合>)选择。
2. 在原会话展开 **Worker result** 工具卡片，看 Worker 的原文和任务 ID。宿主同时保存产出 Bot、会话、执行轮次与消息位置。Assistant 可以报告任务状态，但卡片中的原文不靠它复述。
3. 在这个会话用 `/studio-result` 取回最新任务，或在任意 Studio Assistant 会话用 `/studio-result <任务ID>` 取回指定任务。此命令不调用模型，不需要 Worker 在线。宿主重启后，已经保存的成果仍可读；未完成的任务显示为中断，不自动再派一遍。

文字请求和结果各限 32,000 个 UTF-16 代码单元。三分钟内未完成时，宿主会请求取消 Worker，再关闭其会话。超时、失败或没有完整文字时，不把中间内容当作完成。文字任务不授予任何文档写入权，也不用于运行外部长作业。

### 限定普通文字 Worker 的模型组合

在隔离 profile 的原有 Studio 条目中，可用 `textWorkerRoutes` 列出允许的组合，用 `textWorkerDefaults` 和 `textWorkerBounds` 分别给 Assistant 和 Leader 指定 Worker 的默认组合和派工范围。保留 `stateDir` 和其他已设选项。下例只展示配置写法，请填写实际的 Provider、模型和思考深度 ID，不要填显示名称或凭据。

```yaml
- id: dsh-superagent-managed-worker
  disabled: false
  config:
    stateDir: /absolute/path/to/managed-worker-state
    textWorkerRoutes:
      - provider: example-provider
        model: example-writing-model
        reasoningEffort: low
      - provider: example-provider
        model: example-analysis-model
        reasoningEffort: medium
      - provider: example-provider
        model: example-analysis-model
        reasoningEffort: high
    textWorkerDefaults:
      assistant:
        provider: example-provider
        model: example-writing-model
        reasoningEffort: low
      leader:
        provider: example-provider
        model: example-analysis-model
        reasoningEffort: medium
    textWorkerBounds:
      assistant:
        max:
          provider: example-provider
          model: example-analysis-model
          reasoningEffort: medium
      leader:
        min:
          provider: example-provider
          model: example-analysis-model
          reasoningEffort: medium
```

使用 `textWorkerBounds` 时，按自己的偏好把 `textWorkerRoutes` 从低到高排列。`min`、`max` 都按三个字段定位清单中的一行，范围包含端点。只设 `min` 就不设上限，只设 `max` 就不设下限；省略角色或填 `null` 就不另设范围。上例中 Assistant 可用第 1、2 行，Leader 可用第 2、3 行；第 2、3 行虽然是同一模型，思考深度不同，属于两个组合。清单顺序不代表模型的通用能力排名。

发起会话仍用自己的模型。配置了角色默认值时，照常交代文字任务或派工，Worker 使用该默认值；没有默认值时，Worker 沿用会话选择。若会话未选思考深度，宿主先核验适配器报告的默认深度，再检查组合是否在清单和角色范围内。三个选项都不设时保持原行为。

这些配置只影响 Assistant 的单项文字委派和现任 Leader 的手动文字派工。分项调查、Advisor、文档、飞书收件和自动作业接续仍走各自的路线。宿主只核验并固定选中的组合，不按顺序自动挑选，也不在默认值不可用或越界时换用其他组合。

- **启用时遇到 `TEXT_WORKER_MODEL_NOT_ALLOWED`：** 设置默认值或端点时，清单不能为空。确认默认值和端点都与清单中的某一行完全匹配、`min` 不在 `max` 之后，且默认值在本角色范围内。
- **派工时遇到 `TEXT_WORKER_MODEL_OUT_OF_BOUNDS`：** 所选组合虽在清单上但不在该角色范围内，宿主未创建 Worker。若设了角色默认值，请核对默认值和范围；改发起会话的模型不会覆盖它。未设默认值时，在发起会话选择范围内的组合，必要时明确选择思考深度。
- **派工时组合不在清单或无法核实（`TEXT_WORKER_MODEL_NOT_ALLOWED`／`TEXT_WORKER_MODEL_UNCONFIRMED`）：** 先核对适配器是否仍支持该组合。已设角色默认值就修正配置；未设默认值才在发起会话选择合适的组合。

宿主以适配器的元数据为准，不另行探测远端账户、额度或价格。

修正后，Assistant 可以用一条新消息重新提交完整请求。Leader 先用 `/studio-project work <待办ID>` 核对状态：未派工或预留已释放时可派同一待办；如果 Worker 启动后已记为 `failed`，再次派同一 ID 只会返回旧记录，需要重新登记待办。

### 未立项的分项调查与整合

在 Studio Assistant 中明确要求「分别检查两份记录，然后比较结论」，把共同要求和两至三份可区分的原始材料放进同一条消息。Assistant 只选择原消息中的要求和材料片段；片段不能重叠，也不能凭复述补齐缺失材料。这个流程不创建项目或 Leader，不访问附件、文件和网络。

宿主按顺序派独立 Worker 调查，每个只收到共同要求和被分配的片段。全部完成后，另一个 Worker 取得这些材料与已保存的调查原文，负责核对和整合。所有 Worker 都沿用本次派工时选择的模型和思考深度，不能使用工具或继续派工。任一调查失败、被取消或结果不能安全传给整合 Worker 时，不会把缺少依据的比较报为完成；已经保存的部分仍可读。中断后不会自动重跑。

展开 **Study synthesis** 卡片，或用 `/studio-result <任务ID>`／`/studio-study <任务ID>` 取回整合 Worker 的原文和各步出处。用 `/studio-study <任务ID> <步骤号>` 查看某一步的材料和原结果。查询不调用模型，也不需要原 Worker 在线。

## 建立项目与移交管理权

已接入项目创建、管理权移交和文字待办派工。不会把复杂任务自动升级为项目。

在 **SuperAgent Studio Assistant** 会话中，可以直接用普通话说明这是要长期推进的项目，以及要达到什么目标，例如「把刚完成的资料对照接着做成长期项目，维护每月的差异记录」。不需要固定句式或命令。先核对原生确认框里的项目名称、目标和关联成果，然后选择 **Create project**。Assistant 的建议本身不创建项目；拒绝、跳过或等待超时都不立项。确认后会建立独立的 Leader 会话，不启动 Worker。关联成果目前限原 Assistant 会话里已完成的文字任务，不重做。用 `/studio-project proposal` 或带上回执中的建议 ID，可在该 Assistant 会话查看决定；宿主重启不会继续等待旧问答。

也可以直接在 Leader 会话中操作：

1. 在未绑定项目的 **SuperAgent Studio Leader** 会话中提交 `/studio-project create {"name":"资料整理","objective":"持续整理研究记录"}`。回执给出项目 ID、Leader Bot、当前会话及管理轮次 `1`。可用 `leaderBotId` 复用已有 Leader Bot，用 `originTaskId` 引用一个已经完成的文字任务；引用原成果不重新派工。
2. 在当前 Leader 会话中用普通消息要求登记一项自包含的文字待办，将所需材料放在同一条消息里。登记保留原文与来源，不会启动 Worker。用 `/studio-project work` 可查看最近 20 项。需要执行时，让当前 Leader 派工指定待办 ID。普通派工使用 Leader 的[派工默认组合](<#限定普通文字-worker-的模型组合>)，或在未设默认值时沿用会话选择；只想改这一次时，可[另行选择组合](<#为一项待办选择一次派工模型>)。文字 Worker 不能用工具或修改文档。
3. 用 `/studio-project work <待办ID>` 查看原请求、状态和 Worker 的原始结果，不调用模型。在同一项目的 Leader 会话中，Worker 结束或宿主重启后仍可取回已保存结果。已经开始的工作中断后会留下状态，不会自动重跑。
4. 要换管理会话，在从未绑定项目的 Leader 会话中提交 `/studio-project take <项目ID> <当前管理轮次>`。默认保留 Leader Bot；末尾可追加已有 Leader Bot ID 或 `new` 以换负责人。旧会话仍可用 `work` 查询本项目的工作记录，但不能再登记或派工。移交前尚未开始的保留名额会释放，由当前 Leader 决定是否继续原待办；已经开始的 Worker 可保存原出处的结果。

如果移交报轮次过时、命令重复，或回执不明，先在原 Leader 会话用 `/studio-project status` 核对当前会话和轮次，也可在新的 Leader 或 Studio Assistant 会话用 `/studio-project status <项目ID>` 查询。不要原样重发旧的移交命令。

### 查看文字派工为何未完成

在**现任 Leader 的普通 Web 会话**用 `/studio-project work <待办ID>` 查看文字待办。如果最近保存的派工记录是失败、中断或开始前释放，详情中的 **Saved dispatch diagnosis** 会显示执行轮次、已知原因和建议核对的事项。组合无法核实时，可检查适配器和已选组合；记录到额度停止时，可用 `/studio-quota status` 查看当前状态。如果只知道「未保存完整成果」，不能据此判断模型能力不足。

说明只反映已保存的记录，不探测 Provider 是否恢复，也不改变待办或授权。预约释放表示该轮次没有进入 Studio 的运行状态，已用的一次性组合不会恢复；失败或中断后不能用同一待办 ID 重跑。如果后一次派工还没写入执行记录就被拒绝，详情仍会显示旧记录；请以那次拒绝的回执为准。

### 标记文字待办受阻

如果一项独立文字待办还不能继续，在**现任 Leader 的普通 Web 会话**用 `/studio-project work <待办ID>` 打开命令模板，填写障碍和需要满足的条件。例如：

```text
/studio-project block-work {"workId":"<待办ID>","reason":"原始资料仍在复核","resumeWhen":"资料负责人确认原资料可以使用"}
```

回执给出受阻 ID。受阻期间不能派工；已有的预约若还没进入运行状态，会同时释放，已用掉的一次性模型选择不会恢复。重启或移交不会解除受阻。列表和交接只显示状态；现任 Leader 可在待办详情查原因、条件和出处。此操作不停止已经开始的 Worker，不改已有结果，也不控制文档或外部作业。

核实条件已经满足后，等现任 Leader 的当前对话结束、消息队列为空，再从详情复制解除模板并写明核实结果：

```text
/studio-project unblock-work {"workId":"<待办ID>","blockId":"<当前受阻ID>","change":"资料负责人已确认原资料可以使用，无须修改原请求"}
```

Studio 只保存所有者的确认，不代为核实。解除不会恢复旧预约或启动 Worker；确认模型、额度和引用仍可用后，再按详情提示单独发送新的 `派工 <待办ID>`，有一次性选择时则使用带选择 ID 的[派工消息](<#为一项待办选择一次派工模型>)。若输入或目标需要改变，另登记待办，不用解除操作改写原请求。

### 为一项待办选择一次派工模型

配置 `textWorkerRoutes` 后，可在**现任 Leader 的普通 Web 会话**为尚未开始的文字待办固定一次派工组合。在 `/studio-project work <待办ID>` 找到命令模板，填入清单和 Leader 范围内的 Provider、模型与思考深度。例如：

```text
/studio-project use-model {"workId":"<待办ID>","route":{"provider":"example-provider","model":"example-analysis-model","reasoningEffort":"high"}}
```

登记只保存选择，不查询适配器、启动 Worker 或改变默认值。确认待办与组合后，从回执复制这一整行，作为一条新的纯文字消息发送，不编辑旧消息，也不附加代码围栏或附件：

```text
Dispatch work <待办ID> with model <选择ID>
```

也可单独发 `派工 <待办ID> 使用组合 <选择ID>`。宿主核对两个 ID 和组合的当前可用性，只把原任务和已明确允许的引用交给无工具 Worker。此入口不适用于文档或外部作业，也不改变 Leader 会话自己的模型。

- **取消或改选：** 待办仍未启动且没有占用的预约时，可用 `/studio-project clear-model <待办ID> <选择ID>` 撤销。旧选择 ID 随即失效。若要用普通路线，撤销后另发 `派工 <待办ID>`；若要换组合，重新登记后再用新 ID 派工。
- **拒绝或中断：** 先用 `/studio-project work <待办ID>` 查状态，不盲目重发。组合校验未通过时，选择未消耗；核对该选择或撤销，改会话模型不能替换它。预约成功即用掉选择，后续释放也不恢复；若仍待办，须先清除才能另行派工。已开始并结束的工作只查记录，不重跑。宿主不会自行换模型。
- **重启或移交：** 重启后未使用的选择可由原 Leader 查到，仍须另发明确派工消息。移交后旧选择失效，接手会话若要派工，须先清除，再另选组合或发普通派工消息。

### 查看移交时记录和当前待办

开启 `memory: true` 后，`take` 移交管理权并释放尚未启动的派工名额，同时自动保存交接记录。`take` 的命令回执会提示查看方式，无需另发登记指令。记录包含移交前后的 Leader Bot、Session、管理轮次和原命令，以及最近最多 12 项待办的状态与出处，不复制任务、成果或文档正文。

在**现任 Leader 的普通 Web 会话**中用 `/studio-project handoff` 查看当前管理轮次的交接；加轮次可查本项目的指定记录。查询回执分成「移交时」与「同一批待办的当前状态」。例如，移交时正在执行的 Worker 后来保存了结果，只有当前栏会显示已完成及成果位置。超过 12 项时，查询会提示两栏都只覆盖记录中的待办，而非全项目。

没有交接记录不等于没有待办，仍可用 `/studio-project work` 查看工作；按待办 ID 查询可取回已保存的正文。旧 Leader 的 `work` 历史查询不变，若要看交接记录，先用 `/studio-project status` 核对现任会话，再到那里查询。

接续前按当前状态核对项目归属、暂停或待核对事项，以及文档或作业的授权版本。移交不会授予新权限，旧管理会话的作业自动接续许可随移交失效；查询不更改现有授权。两条命令都不调用模型或重跑任务。

### 项目待办关联文档任务

先登记项目待办但不要派工，再在独立的文档 Worker 会话[登记确切写入授权](<#文档写入控制>)。在当前 Leader 会话用 `/studio-project attach-document <待办ID> <文档任务ID> <授权版本>` 关联两者。一个待办只能关联一个任务，关联后不再作为文字待办派工，也不能同时关联外部作业。关联不批准写入、不改变 Worker 或授权版本。

更正、暂停和继续仍由当前文档 Worker 的命令处理，包括[从白名单飞书私聊收取更正](<#飞书私聊登记>)。项目在 `/studio-project work <待办ID>` 显示原请求、文档状态和当前 Worker；提交后还能用同一命令取回原正文、提交会话和工具调用出处，不调用模型。共享文档后来有新修订时，项目仍展示这项工作提交的版本。换 Leader 只移交项目管理权，不会改动文档已授的权限。

#### 查看已生效的文档范围更正

在**现任 Leader 的 Web 会话**用 `/studio-project work <待办ID>`，可以查看待办关联后已经生效的最近四次范围收紧。每条显示授权版本如何变化、保留的已批准变更行总数（最多列出 12 个行号），以及原消息出处。Web 消息回当时的文档 Worker 会话核对；飞书消息按 ID 在原绑定私聊核对。不再次复制更正或批准正文。待核对、取消或未保存的更正不会列为已生效；仍需处理的消息用当前文档 Worker 的 `/studio-doc inbox` 查看。

这段历史与上方的当前授权、下方实际提交的文档分开显示。Leader 移交后，这段历史随原待办保留，由接手会话查询；旧 Leader 仍能查看原先有权查看的待办内容，但不显示此栏。查询不会启动 Worker 或改变权限。

### 从已完成的成果登记项目事实

在 Studio 宿主配置启用 `memory: true` 后，所有者可以在**现任 Leader 的普通 Web 会话**把本项目已完成的独立文字成果选入档案。选择一段不含秘密的原文，先用 `/studio-project work <待办ID>` 核对，再登记：

```text
/studio-project record-fact {"key":"format-result","expectedEpoch":1,"expectedRevision":0,"workId":"<待办ID>","quote":"成果中原样出现的一段话"}
```

`expectedEpoch` 用 `/studio-project status` 显示的当前管理轮次；新键的 `expectedRevision` 填 `0`，更正时填 `/studio-project fact <键>` 显示的当前修订。键由小写字母开头，可含小写字母、数字和连字符，最多 64 个字符。引用必须与已保存成果逐字匹配；未完成工作、文档写入、外部作业和其他项目的成果不作为这个入口的来源。

用 `/studio-project facts` 列出当前条目，`/studio-project fact <键>` 可取回选定原文及 Worker、结果消息和登记出处。`/studio-project fact-history <键> <修订>` 只查那次登记的出处，不返回旧原文。档案按项目保存，移交后从新 Leader 会话继续查询和更正；旧管理会话不能访问此档案入口，原 `work` 查询不变。

这些记录说明所有者选用了哪一段成果，不等于 Studio 独立核实了其中的结论。登记和查看不调用模型、不派工、不写文档，也不会把项目事实变为全局偏好。

### 在一项项目待办中使用当前事实

开启 `memory: true` 后，在**现任 Leader 的普通 Web 会话**用 `/studio-project fact <键>` 核对当前修订。另发一条普通消息，首行写项目 ID、事实键和修订，下一行起写这次任务：

```text
Studio project fact: <项目ID> format-result v1
根据这条事实写一段简短说明。
```

可从 `fact` 回执复制首行。在空闲会话新发一条纯文本消息，不编辑旧消息，不加代码围栏或附件。Studio 核对来源后只登记待办，不调用模型；如果没看到登记回执，先用 `/studio-project work` 确认是否已登记，不要直接重发。

要派工，再单独发送 `派工 <待办ID>` 或复制回执中的 `Dispatch work <待办ID>`。只有该次无工具 Worker 收到已核验的摘录，不会带上原成果的其余正文。摘录只作参考，不授权文档修改、外部作业或其他任务。

派工回执只报告状态和出处；完成后，在现任 Leader 会话用 `/studio-project work <待办ID>` 免模型读取 Worker 原文。若事实已更正或原成果无法核验，旧待办不会自动换用新版本；尚未派工的不会启动，已经完成的也只显示结果出处。要用新版本，先用 `/studio-project fact <键>` 核对后另行登记。派生结果不能重新登记为无依赖的项目事实，也不能作为 Advisor 的证据。

### 在一项项目待办中引用已交付成果

开启 `memory: true` 后，在**现任 Leader 的普通 Web 会话**登记一项文字待办，先不派工。用 `/studio-project work <原待办ID>` 查看同一项目已完成的独立文字成果，复制一段只出现一次的原文（最多 1,000 个 UTF-16 码元），再执行：

```text
/studio-project use-result {"workId":"<未派工的待办ID>","sourceWorkId":"<原待办ID>","quote":"原成果中的确切摘录"}
```

可从原成果详情复制命令模板，填入目标待办 ID 和摘录。若摘录含双引号、反斜杠或换行，按 JSON 规则转义，不要改写原文。登记引用不调用模型、不新建待办或启动 Worker。登记成功后，另发一条 `派工 <待办ID>`，或直接复制回执给出的 `Dispatch work <待办ID>`。只有负责这项待办的无工具 Worker 能收到摘录，不会读到原成果的其余正文。不要选含秘密的摘录；摘录只作资料，不是新指令或授权。

每项待办只能固定一个摘录，不能换绑，也不能与项目事实、受管文档或外部作业混用。来源失效时不会换用相近摘录，旧派生成果只显示保存出处。当前来源可核验时，用 `/studio-project work <待办ID>` 读取派生成果；不能把它再当成独立来源登记为项目事实、供 Advisor 参考或继续引用。

### 保存同一 Bot 可复用的经验

启用 `memory: true` 后，可以在现任 Leader 的普通 Web 会话为该 Bot 登记一条通用方法。先用 `/studio-project fact <键>` 核对本项目的来源事实及当前修订，再把方法和适用条件分别填入 `method` 和 `conditions`。不要把项目正文、专属参数或授权复制进方法：

```text
/studio-project record-experience {"key":"report-method","expectedEpoch":1,"expectedRevision":0,"method":"用编号小标题便于查阅。","conditions":"适用于按顺序组织的短报告。","factKey":"format-result","factRevision":1}
```

- `/studio-project experiences` 列出该 Bot 的最新经验修订并标明来源是否仍有效；`/studio-project experience <键>` 取回有效方法、适用条件和出处。同一 Bot 负责其他项目时也可查用；不同 Bot 不会继承。回执只提供来源坐标，不开放来源项目的档案正文。
- 改写经验时用当前管理轮次和经验修订，再选择本项目的一条当前事实作为来源。来源事实修订或原成果无法核验后，旧经验不再返回方法；`/studio-project experience-history <键> <修订>` 仍可查出处。

当前入口只记录所有者明确提交的方法，不自动提炼、调用模型、转送项目事实或授予动作权限。

## 按需咨询 Advisor

咨询默认关闭。要开启，在 Studio 宿主的 `config` 中配置一个已注册的路由；示例的标识须换成该 profile 实际可用的值：

```yaml
advisor:
  provider: configured-provider
  model: configured-model
  # reasoningEffort: supported-effort
```

Studio 在咨询前核对路由及思考深度；未指定深度时使用该适配器的默认值。模型组合不从消息中选择，不支持时不换模型或账号。咨询同样受[额度停止](<#共享额度停止与恢复>)约束。

- 未立项时，在 **Studio Assistant** 会话明确提出要请 Advisor 判断的问题，可在同一条消息附上可用的原文证据。项目内在**现任 Leader** 会话直接提出，不经 Assistant。如需引用本项目一项已完成、未关联文档或外部作业的文字待办，将它的准确待办 ID 写入消息；Studio 会取出该待办已保存的 Worker 结果，而不是让 Advisor 访问文档、作业输出或别的项目。
- 展开 **Advisor opinion** 卡片，或用 `/studio-advice <咨询ID>` 取回原问题、引用和意见出处。未立项意见由同一 Assistant Bot 取回；项目意见可在本项目的现任或历史 Leader 会话查阅，但移交后旧 Leader 不能再发起咨询。取回不调用模型，关掉咨询配置也不影响已有意见。
- Advisor 在独立会话中只提出建议，没有工具或派工权。保存意见不会新增待办、启动 Worker、修改文档或授予任何执行权限。同一请求不会重做，宿主重启也不重放中断的咨询。

## 管理已登记的长期偏好

在 Studio 宿主的 `config` 中设置 `memory: true`（默认关闭），然后在普通 **Studio Assistant** Web 会话使用 `/studio-memory` 或下方的自然语言入口。这里只收所有者明确要求长期适用的偏好；不要填密码、令牌、项目机密或一次性要求。`/studio-memory` 命令不调用模型，保存的偏好也不会自动加入后续对话或改变任务授权。

- **登记与查看。** `/studio-memory remember {"key":"report-format","text":"报告使用编号小标题"}` 创建全局偏好。键由小写字母开头，最多 64 个字符，可含小写字母、数字和连字符。可以加 `projectId` 只用于已存在的项目。`/studio-memory list [项目ID]` 列出当前条目，`/studio-memory read <键> [项目ID]` 读正文；省略项目 ID 时只查全局，指定项目时也可查适用于该项目的全局偏好。
- **纠正或限域。** `/studio-memory correct {"key":"report-format","expectedRevision":1,"text":"短报告使用编号小标题"}` 只更新指定的当前修订，不改变作用范围。`/studio-memory restrict report-format 2 <项目ID>` 将全局偏好限到一个项目；成功后再从全局查询就不会读到该条目。后续操作使用回执里的新修订号；遇到过期版本，先查当前记录，不要照抄旧命令重发。
- **忘记与查出处。** `/studio-memory forget <键> <当前修订>` 停用条目。同一个键不会被旧命令或重新登记激活。`/studio-memory trace <键> [修订号]` 只显示来源会话、命令或确认编号及事件位置，不返回旧正文。忘记不删除原始对话或历史记录，也不暂停任务。

Studio 不从历史聊天提炼偏好，已有旧资料不会因为打开这个入口而成为当前记忆。[项目事实](<#从已完成的成果登记项目事实>)与 [Bot 经验](<#保存同一-bot-可复用的经验>)分别存放，不会被当成全局偏好。

### 用自然语言查看偏好与出处

在普通 **Studio Assistant** Web 会话里，单独发送一条查询，不必输入斜杠命令。例如：

| 消息 | 回执内容 |
| --- | --- |
| `你记住了哪些偏好？` | 当前有效的键和版本；有更多条目时给出翻页命令。 |
| `查看偏好 report-format` | 该键当前有效的正文、作用范围及出处。 |
| `偏好 report-format 的出处是什么？` | 当前修订的登记或更正出处，不返回正文。 |
| `偏好 report-format v1 的出处是什么？` | 指定修订的历史出处，即使该版本已失效也不返回旧正文。 |

查询默认只看全局偏好。在消息末尾加 `（项目 <项目ID>）`，可查适用于该项目的偏好；只接受明确的项目 ID，不从聊天猜项目。像「这条偏好的出处是什么？」会提示补上键。Studio 用原生只读回执显示这些结果，不调用模型，不派工，也不把正文加入后续模型上下文。先前查到的回执仍是历史；要确认现在是否有效，请重新查询。

### 用自然语言登记长期偏好

在同一个普通 Assistant Web 会话，只发一条明确希望长期记住的偏好，例如「请记住：以后的报告使用编号小标题。」Assistant 可就这条消息提出登记建议。确认框会显示原话、要保存的文本和键；只有在当次选择 **Save preference**，且消息仍有效、键未用过时，才创建全局偏好。用 `/studio-memory trace <键>` 可核对确认编号和原始消息的位置。

目前只识别少数明确的中英文短句，不从引文、一次性任务或旧会话自动提炼。取消、超时或重启不会补做确认；同一条来源不会重复询问。这条路径不会额外派工或授予权限。

### 用自然语言纠正一条偏好

先查到偏好键、当前版本和作用范围。在普通 **Studio Assistant** Web 会话单独发送一句，例如「把偏好 report-format v1 改为：以后用简短小标题。」如果条目已限在某个项目，要在版本后、`改为` 前加 `（项目 <项目ID>）`；省略项目只更正全局条目，不会把项目偏好改成全局偏好。

确认框会显示原话、目标版本、范围和将保存的新正文。选 **Apply preference correction** 才提交，而且提交时目标必须仍是同一版本和范围。选 **Not now**、确认超时、宿主重启或其他会话先修改都不会应用这次更正；发生版本冲突时先查现版，不要照抄旧消息重发。成功后可用 `/studio-memory trace <键>` 查到确认编号和原消息位置。这条路径不调用模型、不派工，也不改变任务授权。

### 用自然语言限域或遗忘偏好

在普通 **Studio Assistant** Web 会话单独发一句，写明偏好键和当前版本：

- **限域：**「把偏好 report-format v1 限定到项目 <项目ID>。」核对目标项目并选 **Restrict preference**。只能把全局条目限到一个已存在的项目，原正文不改；不能在项目之间迁移，或扩大为全局。
- **遗忘：**「忘记偏好 report-format v2（项目 <项目ID>）。」核对并选 **Forget preference**。省略项目只适用于全局条目。遗忘会停止使用该条目；同一键不会被重投或重新登记激活。原始对话、成果和审计记录不删，任务授权也不变。

两种操作都按确认框的版本和范围提交；若其他会话先改了条目，旧确认不生效。操作不会调用模型。成功后，旧引用不再解析，仍可查其历史出处；不会自动生成新版引用。仍可使用 `/studio-memory` 命令。

### 引用一条偏好的指定修订

用 `/studio-memory cite <键> <当前修订> [项目ID]` 保存引用，回执给出引用 ID。引用只保存来源修订、使用范围和创建出处，不复制偏好正文。省略项目 ID 时，引用只在未立项范围使用；即使来源是全局偏好，指定项目创建的引用也只能在该项目解析。

- 用 `/studio-memory resolve <引用ID> [项目ID]` 查看。项目 ID 必须与创建引用时一致，原条目还须在该范围有效且仍是同一修订。纠正、限域或忘记后，旧引用不会跳到新修订或返回旧正文。
- 用 `/studio-memory trace-citation <引用ID>` 查创建出处和来源修订，即使引用已失效也能查。它不返回正文；如需采用最新内容，先读当前偏好再明确创建新引用。

创建和查看引用不会启动任务，也不会改变授权。如需把引用用于一次派工，按下面的方式在新任务中明确指定。

### 在一项文字任务中使用偏好引用

先用 `/studio-memory cite <键> <当前修订>` 创建未立项引用。在普通 **Studio Assistant** Web 会话中，发送一条新的纯文字消息：首行写 `Studio preference citation: <引用ID>`，换行后写完整任务。例如：

```text
Studio preference citation: 00000000-0000-4000-8000-000000000000
根据以下两点起草一份简短报告：样本已核对，复核意见待补。
```

将示例 ID 换成实际回执。只有该任务的一次性 Worker 会收到偏好正文，原任务不改写。偏好只作格式参考，不能覆盖本次明确要求、增加任务或授权操作。没写首行就不会带入偏好；首行无效、重复、引用限于项目或已失效时，这条派工路径不会改成不带引用的任务继续执行。

Assistant 和工具卡只显示回执。用 `/studio-result <任务ID>` 取回成果；如果来源已纠正、限域或遗忘，或者关掉了 `memory`，就只返回任务状态和引用出处，不替换为新版。Studio 会在中转给 Worker、每次模型尝试和收存成果前核对原修订，不会重放旧任务。

已经发出的模型请求无法追回。原生 Worker 日志和先前查看的命令输出仍是历史记录，不代表偏好或成果仍可用于新任务。如宿主启用了 DeepSeek 会话日志扩展，Studio 排除 Assistant 会话和带这类引用的 Worker 会话，不把它们的原始记录附加到模型请求。

## 文档写入控制

要替换已明确授权的文档，请在新的普通会话中选择 **SuperAgent managed document Worker**。不要在 Assistant、受托起草文字的 Worker、旧执行器或 DSH 子代理会话中登记这项授权。文档 Worker 使用只读沙箱，写入只能通过宿主注册的 `studio_write_document` 动作。

1. **登记一条确切授权。** 在 Worker 会话中提交 `/studio-doc start {"initial":"旧正文","replacement":"获准的新正文"}`。回执包含任务 ID、执行轮次、授权版本和文档版本。用 `/studio-doc continue <授权版本>` 让 Worker 提交这次修改。只有登记的新正文与预期文档版本 `1` 完全匹配时，动作才可能把文档更新到版本 `2`。普通聊天文本不增加权限。多个任务要修改同一文档时，按下文用文档 ID 绑定，不要分别用 `initial` 创建副本。
2. **暂停和查看状态。** 在当前 Worker 会话中提交 `/studio-doc pause`。收到 `Pause effective` 时，暂停与新授权版本已经提交。随时可用 `/studio-doc status` 查看状态，不会返回正文。若回执说暂停未保存，宿主仍阻止该任务写入，而且不提供可用的恢复版本；可重试暂停，或在宿主重启后重新打开会话查看状态。
3. **移交到新 Worker。** 新建一个尚未绑定任务的同预设会话，在那里提交 `/studio-doc transfer <任务ID> <当前执行轮次>`。移交保留已登记的文档内容范围和暂停状态；旧会话不能再写入。
4. **恢复暂停的任务。** 核对任务和写入范围后，在当前 Worker 会话中提交状态或移交回执给出的 `/studio-doc resume <授权版本>`；过时的版本不能恢复写入。收到 `Execution resumed` 只表示重新允许写入，不会重跑旧动作。用回执中的新版本执行 `/studio-doc continue <授权版本>`。

### 查看文档写入为何未放行

文档 Worker 的工具回执区分以下情况，不把它们报成写入成功：

- **明确超出批准范围**（例如 `ACTION_NOT_APPROVED`）：待写正文不符合本任务的授权。改写命令或换调用方式不会改变授权。
- **当前任务状态阻止写入**（例如 `TASK_PAUSED`、`STALE_AUTHORIZATION` 或 `SHARED_DOCUMENT_CONFLICT`）：先用 `/studio-doc status`、`/studio-doc inbox` 核对实际轮次、授权和待核对消息；不要沿用旧批准。
- **技术上无法确认**（例如 `STORAGE_ERROR`、`INSTRUCTION_UNCONFIRMED`）：这不是业务范围拒绝。恢复后先核对文档和任务实际状态，再决定是否需要继续；不按旧回执自动重试。

在**当前文档 Worker 的 Web 会话**用 `/studio-doc guard` 查看该任务最近的证据，或加上工具反馈中的完整证据 ID 查看一条。记录只保留轮次、当次检查或原许可的授权版本、目标版本（若已核对）、调用编号、阶段和原因，不复制正文。每项任务最多保留 64 条，跨执行轮次共用；达到上限或存储无法确认时，回执会说明未保留新证据。查询不调用模型，也不重新审核、解除暂停或授予写入权限。

### 复核明确的文档范围拒绝

如果怀疑守卫误读了原来批准的替换正文，在空闲的**现任文档 Worker** 查看 `/studio-doc guard <证据ID>`，复制回执中的 `/studio-doc guard-review <证据ID> <授权版本>`。该指令只核对初审的 `ACTION_NOT_APPROVED`，不填写新正文，也不要求你重复批准；宿主从原生会话读取当次调用，与该版本已登记的批准正文重新比较。旧记录没有原生调用坐标、原调用不可读，或轮次、授权、目标版本已变时，不凭聊天摘要补证。暂停、待核对和技术故障不能用这条指令绕过。

- **原拒绝成立**（`Original refusal confirmed`）：当次调用的拟写正文与获准正文不同。不要换一种写法重发同一个效果。
- **原比较矛盾**（`Comparison inconsistent`）：当次调用与获准正文相同，但原初审报了不符。保留证据供排查；不要重播原调用。

每项任务的同一授权版本最多记录一次已完成的复核，换证据 ID 也不能再做一次。用 `/studio-doc guard <证据ID>` 可查原结论和复核结果。复核不调用模型，不复制正文，不发放写入许可，也不启动或恢复任务；任何新写入仍须走原有的守卫和提交检查。

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

可以在 GUI 或已绑定的飞书私聊发「先暂停修改」或「只改第1行」。在当前文档 Worker 执行不带参数的 `/studio-doc review`，宿主会对最早的待核对消息提出暂停或只保留指定行的建议。建议不调用模型；确认框会展示原话、任务、版本和将生效的效果。选择 **Apply correction** 后，只有版本仍匹配才保存。若取消、确认过期、消息迟到或句意无法明确识别，不会按建议修改授权；用 `/studio-doc inbox` 核对。

1. **手工核对。** 用 `/studio-doc inbox` 查看最早的消息、来源和当前版本。若显示 **Approved changed lines**，也可复制 `/studio-doc narrow` 模板，把 `keepLines:[]` 换成要保留的行号，例如 `"keepLines":[1]`。行号从 `1` 开始，必须保留至少一行、但不能保留全部原批准变更。其他行保持起始正文。新增行、删除行、改换行格式，或根据标为迟到的飞书消息窄化，都不受支持；若不确定应该保留哪些改动，先暂停。
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
2. 从指定私聊发送更正。未绑定时不猜任务；回执只确认消息已登记、文档写入暂被阻止，不代表新指令已经生效。若未收到回执，可在当前 Worker 会话用 `/studio-doc inbox` 核实，不必重发。更正消息不会直接唤起 Worker 或启动工作。
3. GUI 和飞书共用同一待核对列表。相同飞书消息只登记一次；若发送时间早于同一私聊已登记消息，会标明可能乱序。两个渠道的时间不能直接比较，也不会按最后到达的消息改变确认过的范围。用前述命令核对原消息及来源，再决定是否暂停。

此入口只监听实时送到 CLI 的事件，不补收断线期间的历史；已登记消息的阻断不依赖飞书连接仍在线。

### 从 Web 或飞书继续同一个文档任务

可在 Studio 宿主配置中启用 `documentContinuations: true`（默认关闭）。在普通 **SuperAgent Studio Assistant** Web 会话单独发「继续那个任务」。只有一个未完成的受管文档任务时，宿主才会直接定位；有多项时只返回候选，不替你选择。也可发「继续文档任务 <任务ID>」明确指向原任务。

在启用了文档接收的白名单飞书私聊中，同一句话只指已绑定的文档任务，不能指定其他任务。先在 Web 的当前 Worker 用 `/studio-doc bind-feishu` 完成绑定。续做句式须独立发送；例如「请继续那个任务，谢谢」不会走接续路线，在飞书仍按原文档收件流程处理。要调整范围或暂停，请另发更正。

接续只把**当前批准的内容**送到已打开且空闲的当前 Worker，与 `/studio-doc continue <授权版本>` 共用同一任务、执行轮次和授权版本的投递标识。它不会新建任务、打开会话、解除暂停或越过待核对项；对同一条消息重投也不会重选目标。定位和候选查询不调用模型，成功排队后仍由原 Worker 按守卫核查完成写入。

「已排队或已投递」不等于写入完成。若未收到回执或结果不明，先在当前 Worker 用 `/studio-doc status` 或 `/studio-doc inbox` 核对，不直接重投；同一私聊中已知迟到的续做请求不会启动工作。

### 从飞书发起文字任务并取回

用 `feishuTextInbox` 接收纯文字任务。配置沿用上文五个机器人及私聊字段，另指定绝对 `cwd`、现有 `provider` 和 `model`，可选 `reasoningEffort`。Studio 不从消息中选模型或切换账号。

1. 发送以 `draft:` 或 `起草：` 开头的消息，把所需材料放在同一条消息中，例如 `draft: 把下列数据整理成比较表……`。不带这些前缀不会发起文字任务。每个私聊同时只执行一个文字任务；迟到或忙碌时不会创建任务，也不会补派。收到任务 ID 后不必重发。
2. Worker 只收到前缀后的文字，不具备工具、文档写入权或外部操作权限。Studio 保存原文和结果出处，再尝试以[纯文字回复](<https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-reply.md>)发送，不解析结果里的图片地址或下载内容。超出回复限制时给出取回方式。
3. 在同一私聊发 `result <任务ID>`，或在任何 **SuperAgent Studio Assistant** 会话用 `/studio-result <任务ID>`，无需再次调用模型。会话结束或宿主重启后仍可取回已保存结果；中断的任务不会自动重做。

#### 同一个私聊兼顾文档更正

在 `feishuTextInbox` 中另设 `documentCorrections: true`（默认关闭），不要同时配置 `feishuDocumentInbox`。如果从文档专用配置切换，沿用同一状态目录及四个身份 ID，再补上文字任务的目录和模型配置；无需重新绑定原任务。已有文字任务的私聊也可按上文用 `/studio-doc bind-feishu` 绑定一个原文档任务。

`draft:`／`起草：` 只走文字派工，`result` 只查结果，即使参数无效也不会转成更正。若还启用了 `documentContinuations`，[独立续做请求](<#从-web-或飞书继续同一个文档任务>)也单独分流。其余普通消息只送到明确绑定的文档任务待核对；没有绑定就提示、不猜任务。更正仍须在 Web 核对。开启这个模式后，宿主按消息 ID 保存第一次走的路线；已登记的消息重投不能换路线、修改原文或重复派工，包括之前忙碌或参数无效而没有启动的文字命令。

## 等待已提交的外部长作业

Linux 上可以让项目待办等待一项**已经由外部工具提交**的 systemd 用户服务。在独立 Studio profile 的宿主 `config` 中设置 `systemdJobInbox: true`（默认关闭）。目前只读取本机当前用户管理器中的 `studio-job-*.service` 临时服务，要求 `Type=oneshot`、`RemainAfterExit=yes`、`Restart=no`；Studio 不提交、重启或取消服务。

1. 先在项目中登记后处理待办，不要派工。在当前 Leader 会话用 `/studio-job attach <工作ID> <服务名> <InvocationID>` 关联作业。`InvocationID` 可从 `systemctl --user show --property=InvocationID --value -- <服务名>` 查看。必须能核实这一轮运行；同名服务不是同一个作业。
2. `/studio-job status <工作ID>` 读取已保存的状态和日志引用；`/studio-job check <工作ID>` 核对状态，不调用模型。若服务暂不可查、消失或同名重建，未确认的状态显示为未知，不视为成功或重新提交。已经保存的明确终态保留。等待期间不分配 Worker。
3. `/studio-job pause <工作ID> <授权版本>` 阻止后续派工并撤销尚未开始的派工预留，不停止外部服务或已开始的步骤。观察到作业完成不会解除暂停。核对状态后，用 `/studio-job resume <工作ID> <授权版本>` 清除暂停，再明确让现任 Leader 派发原待办。Worker 取得原文字和作业引用，不读取外部日志、不获得工具。

只有日志服务确实保留了该次运行的记录时，才能凭回执中的 `_SYSTEMD_INVOCATION_ID` 查阅外部日志。Studio 宿主重启不会影响由用户管理器托管的服务。

### 自动观察和接续（可选）

同时设置 `systemdJobPollSeconds: 30`（可选 5–300 秒，`0` 为默认关闭），宿主就会分批检查已关联的作业，即使没有打开 Leader 会话也能记录完成。手工检查和后台检查使用同一份观察记录。**开启检查本身不允许自动派工。**

- 若希望成功后自动派工，在当前 Leader 会话用 `/studio-job auto <工作ID> <授权版本>` 许可原待办的一次文字后处理。许可绑定当前管理轮次、工作目录、所选模型及其配置额度池。作业成功后，需要同一 Leader 会话已打开且空闲、路由仍匹配、额度可用，才会启动 Worker；不会为凑条件切换模型或唤起 Leader 推理。
- 暂停和管理权移交都会使旧许可失效。`resume` 只清除暂停；需要自动接续时，再明确授权。额度恢复也不会重新授予已失效的许可。用 `/studio-job status` 核对外部状态及许可；用 `/studio-project work <工作ID>` 取回派工结果。
- 许可在持久预留时消耗，手工派工与自动派工共用原工作项。同一个许可不会因为预留释放、宿主重启或收到重复观察而再启动；结果不明确时，请查看原记录，不要重发外部作业。

## 共享额度停止与恢复

额度停止默认关闭。只在专用 Studio profile 的宿主 `config` 中开启，并将确实共用同一账户额度的 **provider ID** 列在同一个池里。不要按模型名猜池，也不要为绕过停止重命名 provider 或改配账号。未列入的 provider 不受这些池影响。

```yaml
quotaPools:
  - id: work-account
    providers: [work-route, work-route-alias]
```

收到配置路由明确的 `ACCOUNT_QUOTA` 错误时，宿主先保存停止状态，拒绝同池的新推理和文字派工，并取消该池正在推理或退避的 DSH 轮次。临时 `RATE_LIMIT` 或连接异常不会触发额度停止。已经发到外部的调用不会因此撤回；这条机制也不取消外部长作业。

- 用 `/studio-quota status` 查看池和故障 ID。命令不调用模型。「等待恢复确认」表示宿主不做后台探测，也不把时间到了当成恢复。正常重启保留停止状态；前一轮若异常退出，宿主也会为原来尚无停止记录的配置池保守建立记录。
- 只有从独立来源核实原账户可用后，才使用 `/studio-quota restore <池ID> <故障ID> <核实依据>`。这是所有者确认，不是宿主查询余额或测试调用；不要填写凭据。恢复只重新开放推理入口，不重放先前请求，不解除任何人工暂停。已核实成功的外部作业仍按原有许可判断能否接续。

### 通过飞书接收额度故障通知（可选）

配置了额度池和[专用飞书入口](<#飞书私聊登记>)后，可在同一宿主 `config` 中启用 `quotaFeishuAlerts: true`。默认不发通知。机器人和连接验证通过后，Studio 使用 [lark-cli 的私聊发送接口](<https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-send.md>)，仅向配置的 `ownerOpenId` 发送系统通知，不从聊天内容选取收件人，不向群聊发送。

通知只包含已确认的额度故障、受影响的池和路由，以及 Web 状态查询方式；不附带任务正文、日志或恢复依据。Studio 为每次故障持久登记至多一次发送尝试。没能确认送达时，`/studio-quota status` 会显示当前故障的发送状态；宿主不会因超时、重启或发不出去而盲目重发。没有配置或尚未验证飞书时，仍可在 Web 查询停池状态。

## 用 Watchdog 查看运行状态

在 Studio 宿主的 `config` 中设置 `watchdog: true`（默认关闭）。所有者可以在任一已打开的本地 Web 会话用 `/studio-health` 查询。总览显示配置的额度池与每类最多八项任务或作业记录，超出时会提示；要核对一项，可以用 `/studio-health document <文档任务ID>`、`/studio-health job <待办ID>`，或指定 `draft`、`feishu`、`project`、`study`、`advice` 与相应 ID。

- 文档显示当前执行和授权版本，并区分已暂停、待核对、保存不明及共享文档冲突。配额停止单列，已发送或未确认送达的飞书额度通知沿用原记录。
- 在同一任务的现任 Worker、执行轮次、授权和目标版本下，若两个不同原生调用均有初审范围拒绝的证据，Watchdog 会提示**需核对进展**，列出最近两条。暂停、待核对或目标已变时不把这些记录当作当前疑点；复核发现初审比较矛盾的记录也不计入。提示不证明两个调用想做同一件事，也不等于任务失败。用回执给出的 `/studio-doc guard <证据ID>` 在现任 Worker 核对出处；查询不发通知、不复核或重跑。
- `/studio-health job <待办ID>` 分开显示外部作业的最后观测、后处理及现行自动许可。回执会说明当前许可尚未用、用在哪个执行轮次，或没有现行许可；许可在预约时用掉，即使预约随后释放，也不等于已开始后处理。作业已完成但后处理未开始且未暂停时，快照可以指出这三个事实，但不会核对实时模型路线或额度，也不据此认定漏派。请到现任 Leader 用 `/studio-job status <待办ID>` 读取原记录；如果没启用作业操作，仍可用 `/studio-project work <待办ID>`。
- 核对作业暂停时，Watchdog 用同一待办和执行轮次的开始记录比较授权版本。若 Studio 保存的本轮开始记录早于当前暂停生效，回执会说明两者的先后；只有记录显示开始时确有生效的暂停，才提示记录矛盾。旧执行缺少可核对的开始证据时显示先后未确认。这里的开始是 Studio 保存的状态，不证明 Worker 已调用模型或外部作业有新动作。
- `/studio-health project <待办ID>` 将当前的人工受阻与最近的文字派工记录分开。解除后，过去被释放的预约仍是历史，不表示待办仍受阻，也不自动授权派工。要查保存的原因和继续条件，请到回执列出的现任 Leader 会话用 `/studio-project work <待办ID>`。总览只检查有界的近期记录和活跃派工，未显示的旧待办仍可按 ID 查。
- 会话未出现在当前宿主，只说明没有连接到这里，不能证明工作失败。已确认的中断或失败以执行记录为准，不按多久没有更新推断。需要核对时，可回到相应原任务看详细出处。

查询只读运行元数据，不读取业务正文、不调用模型、不改变授权、不启动或恢复任务。查询本身不轮询或发送通知，也不能代替外部服务健康检查。

### 确认故障后接替文档执行

如需启用，在同一配置中同时设置 `watchdog: true` 和 `documentRecovery: true`。目前只支持一种故障：当前 Worker 执行 `/studio-doc continue`，这条接续是该轮唯一任务输入，原生 DSH 轮次最终以 `TRANSPORT` 错误终止，且文档未提交。宿主保存对应的会话、轮次和事件编号后，`/studio-health document <文档任务ID>` 才显示恢复证据 ID。单次底层重试、取消、会话未打开或普通文字报错不算这类证据。

1. 打开一个未绑定任务、空闲的文档 Worker 会话，运行 `/studio-doc recover <文档任务ID> <证据ID>`。核对确认框里的原轮次和目标会话，再选择 **Replace execution once**。不确认就不替换。
2. 宿主重新核对证据、任务和授权版本。已有暂停、待核对输入、共享文档冲突或证据过期时不替换。成功后同一任务进入新执行轮次，写入保持暂停，不修改已批准的正文，也不启动新会话的推理或取消旧会话。旧轮次的调用即使恢复也不能提交。
3. 在新 Worker 中查看 `/studio-doc status`。若核实仍需继续，另行使用 `/studio-doc resume <当前授权版本>`，再按回执的新版本执行 `continue`。同一证据只能接替一次；重启后旧证据仅作历史记录，不能用来重放接替或恢复写入。

### 通过飞书接收文档故障通知（可选）

在启用了文档接替和[专用飞书入口](<#飞书私聊登记>)的宿主配置中，另设 `documentFailureFeishuAlerts: true`（默认关闭）。宿主在记录新故障或飞书重新连接时，只对仍适用的当前故障登记一次发送尝试。机器人只向配置的所有者私聊发送通知；文档不需要先绑定飞书。通知包含故障类别、任务与证据编号及 Web 查询方式，不包含文档正文、模型输入或错误原文。

在 `/studio-health document <文档任务ID>` 可以核对证据及通知状态。证据已过期、任务已暂停或连接尚未核验时不发送。回执不明时显示送达未确认；重启不会补发。通知不调用模型，不接替执行或恢复写入，也不影响额度通知。

## 宿主重启

受管入口在接收动作前，先把本次运行登记为未确认结束。只有停止接收动作且没有未确认的暂停或指令登记时，才登记为正常关闭。若保存失败后退出、进程异常退出，或首次打开缺少关闭记录的旧实验数据库，宿主无法从数据库判断哪些待写任务受影响。它在开放动作前暂停所有仍待写且未暂停的任务，提高其授权版本，并单独记录这些系统暂停。已提交的文档和已暂停的任务保持不变；若恢复事务也写不进去，受管入口不会启动。重启本身不会重新放行写入。

Studio 的 SQLite 状态只由一个宿主管理，不支持多个宿主共用状态目录或恢复已经回退的数据库。它不会自动接手 GitHub Ticket、迁移旧会话或启动长作业。
