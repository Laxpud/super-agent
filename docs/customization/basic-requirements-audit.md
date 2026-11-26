# Agent Studio 基础需求缺口自查

**核对日期：**2026-11-26　｜　**性质：**需求与实现对照，不作为新增需求或实施计划。

核对现有需求、Studio 的 Web 和飞书入口、角色工具、项目与任务账本、交付和恢复路径。实现依据为当前工作树（基于 `f11d986`，含已有未提交改动）；本地 Worker 的限制也和当前安装版核对过。本次不发飞书消息、不运行模型、不修改配置。以下只能确认哪些交互或边界未被明确指定、实现缺在哪里，不能从这些材料证明遗漏是未实现的唯一原因。

## 已补入的首版要求

[本地工作区执行](requirements/scope-and-roles.md#本地工作区执行)原先只有角色职责与通用能力描述，没有把本地读取、搜索、修改和运行检查定为首版底线。[项目管理](requirements/project-lifecycle.md)补充了本地工作区关联、任务级指定与授权的区别；[验收场景](requirements/design-and-acceptance.md#行为验收场景)要求实际操作、可核对结果和越界拒绝。当前 [Studio 工具注册](../../src/managed-worker/index.ts#L374-L411)仍只有文字、协调与受管文档路径，不能把上述验收记为通过。

## 候选缺口

### 1. 从统一入口把工作交给已存在的项目

- **需求缺到哪一层：**已有[跨渠道接续原则](requirements/interaction-and-delivery.md#L17-L25)和[项目由现任 Leader 组织](requirements/scope-and-roles.md#L58-L68)，也明确[不镜像 Leader 和 Worker 的内部对话](requirements/agent-studio-entry-and-conversation.md#L23-L28)。此前没明确验收一个日常动作：在 Assistant 对话里指名现有项目交办，原请求应到达该项目，而不是留在 Assistant 对话里让它自己处理或另立项目。本轮已把**本地执行**这个用例纳入验收；其他任务的通用定向交办还待明确。
- **现状：**[Web 通过项目选择器切换对话](../../src/studio-web/studio.tsx#L79-L89)，已选中项目才会[按会话地址找现任 Leader](../../src/studio/sessions.ts#L239-L247)。[飞书普通来信固定进入 Assistant](../../src/studio/service.ts#L256-L291)，Assistant 能查项目、提议立项、派文字任务，但[角色工具没有把原请求送给既有项目 Leader 的入口](../../src/managed-worker/index.ts#L385-L391)。个别文档控制路径不等于通用项目分流。
- **建议最低验收：**在飞书明确指向一个已存在的项目，现任 Leader 安排工作；请求、状态及适合原入口查看的结果可追踪，不广播内部对话。无法唯一确定项目时才澄清，不重复建项目或任务。

### 2. 用户能查从交办到交付的任务状态

- **需求缺到哪一层：**[待我处理](requirements/agent-studio-entry-and-conversation.md#L42-L47)有明确职责，只收待用户决定或需人工解除的阻塞；[汇报](requirements/interaction-and-delivery.md#L46-L54)要求有意义的进展和结果。没有单独指定用户怎样查找所有已交办工作，以及消息处理、任务执行、交付三个状态怎样区分。
- **现状：**[Studio 对外操作](../../src/studio/protocol.ts#L98-L111)提供对话、待办和会话记录，没有统一的任务列表或任务详情；已有[项目工作命令](../../src/managed-worker/project.ts#L543-L576)和[Assistant 实时工作查询](../../src/studio/sessions.ts#L190-L197)，但分散。后台任务一经接手，原消息轮次就可[标记为 `completed`](../../src/studio/sessions.ts#L357-L367)，界面[显示为「已完成」](../../src/studio-web/locales.ts#L83)，但这不表示任务已交付。恢复时，[排队和运行中的消息都标为中断](../../src/studio/store.ts#L480-L492)，不自动重跑。
- **建议最低验收：**刷新页面、换入口或重启后，不记底层 Session ID 也能找到同一任务，分别看见未开始、在执行、等确认、受阻、中断或已交付，以及原请求、负责人、结果与适用的下一步。任务视图不应把正常运行事项计入「待我处理」。

### 3. 用户给任务提交实际材料

- **需求缺到哪一层：**[已有资料条款](requirements/memory-and-records.md#L59-L65)说的是历史来源与迁移，[跨端首版同步](requirements/agent-studio-entry-and-conversation.md#L23-L28)只承诺文字；没有指定至少一种非纯文本的**任务材料入口**、材料归属或不支持时的反馈。这不是要求把飞书所有附件都同步。
- **现状：**[Studio Web 发消息只接受正文、回复与引用](../../src/studio/http.ts#L16-L30)，[飞书入口只收 `text`](../../src/studio/feishu.ts#L20-L33)，也没有把附件或受支持的文件引用作为任务材料交给 Worker 的通用路径。引用聊天文本和选择工作区都不能替代显式提交任务材料。
- **建议最低验收：**为一个任务附一份支持的材料（如 Web 上传一份表格或给出可读取的文件引用），只交给获准的执行者。打不开、不支持或需要另一入口时给出明确反馈，不当作已读取，也不要求用户把整个材料粘成文字。

### 4. 交付能取回的非文字成果

- **需求缺到哪一层：**[交付原则](requirements/interaction-and-delivery.md#L46-L54)已要求成果可访问、可重新定位、不因临时目录清理丢失；首版验证没有指定一种文件型交付，也没有界定稳定标识、取得方式和保留边界。
- **现状：**[Studio 成果协议](../../src/studio/protocol.ts#L14-L34)只有标题、文本和 Session 来源，[Web 展开文本和来源](../../src/studio-web/conversation.tsx#L65-L71)，[飞书发送同步文本或确认卡片](../../src/studio/feishu.ts#L297-L324)。可以回传一段文字或人工填的链接，但没有受管文件成果和取回操作。
- **建议最低验收：**Worker 生成一份文件（如表格、图或补丁），任务关联实际产物；Worker 退出后仍能从原任务或另一入口定位并通过获准途径取回。不能直接在飞书提供时说明取得方式，不用本机临时路径冒充可用交付，也不默认外传。

### 5. 项目不是只增不减的对话列表

- **需求缺到哪一层：**[项目生命周期](requirements/project-lifecycle.md#L23-L32)写明了由谁决定结项及可进入维护，但没定义怎样变更已立项的目标、结束或恢复一个项目，以及这些动作如何影响在途任务和历史访问。
- **现状：**[项目表](../../src/managed-worker/project-store.ts#L122-L134)没有生命周期状态；[现有建项和移交路径](../../src/managed-worker/project-store.ts#L537-L584)写入初始目标或更新管理轮次，没有更新项目目标或结项的操作。[项目档案命令](../../src/managed-worker/project-archive.ts#L26-L66)管理事实摘录，不是关闭项目。
- **建议最低验收：**更正项目目标不必另建项目；显式结束后停止按该项目承接新工作，既有成果可查，在途工作和已发出的外部动作按实际状态另行处理。恢复不自动重启旧任务或复用失效授权。

### 6. 飞书发出、Studio 受理和执行是不同的状态

- **需求缺到哪一层：**[跨端需求](requirements/agent-studio-entry-and-conversation.md#L44-L48)已承认手机发送不等于宿主收到，[重复投递规则](requirements/interaction-and-delivery.md#L21-L25)也已写清；未指定用户怎样按原消息核对受理，或断线、回执不明时怎样安全补交。并非要求离线实时处理或自动重放历史。
- **现状：**[飞书入站](../../src/studio/feishu.ts#L214-L251)依赖长连接；无法确认登记时记宿主告警。[使用指南](agent-studio.md#L45-L54)明确不补捞断线历史。已登记任务有派工回执，出站也区分是否确认，但普通来信没有一条普遍可查的受理回执；[未匹配到已有话题的来信还可能不登记](../../src/studio/service.ts#L256-L280)。
- **建议最低验收：**用户能区分一条原消息是否已登记、任务是否已受理执行、是执行结束还是回传未确认；重新提交前能核对或明确确认要补交，重复、旧消息不自动变成新任务。对未受理的重要更正，也不能报为已生效。

## 不归为「没写」的项目

- [与 Worker 在原任务下直接交流](requirements/interaction-and-delivery.md#L13-L17)、[更正撤销后终止旧授权](requirements/interaction-and-delivery.md#L27-L36)、[Guard 对实际动作和副作用的约束](requirements/action-authorization.md#L40-L58)、[共享资源的并发冲突](requirements/project-lifecycle.md#共享资源修改)已经写明。当前主要只在文档、文字或有限控制路径中落地；做本地 Worker 时要据此补实现，不另造重复需求。
- [项目档案和经验的主动维护](requirements/memory-and-records.md#主动记录与纠正)、[能力匹配和有依据的调度](requirements/model-selection.md#选择与调整)、[Watchdog 的主动巡查和恢复](requirements/jobs-and-oversight.md#watchdog-巡查)也有明确要求。现有[进展记录](progress.md)只证明受控引用、手动/预设模型选择、状态观察及若干窄场景，不能用这些代替完整验收。
- 微信里接单、群聊协作、每种 Worker 一个永久 Bot、为每个动作重复人工审批、建设新的远端执行后端，以及自动同步所有原始文件，没有必要作为本次「基础缺口」补进来。

## 建议顺序

1. 用一条真实本地任务验收已补入的要求：指名项目或目录 → 定向派工 → 实际读取或修改及检查 → 回到原请求并可查询。先核实宿主能限制实际文件目标和命令副作用，不能只挂普通工具或设置工作目录。
2. 让用户能查这条任务和实际结果，再补最小材料输入与文件交付，形成不依赖全文粘贴的流程。
3. 敲定项目日常管理和断线受理、补交的行为，再扩展到更多任务类别、资料类型和执行环境。

只有本地工作区执行已写入需求；其他候选留待确认。
