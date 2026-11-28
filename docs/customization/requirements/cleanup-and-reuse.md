# 现有代码保留与清理边界

> **更新日期：** 2026-11-27　｜　**定位：** 盘点当前仓库代码、配置与文档，明确“保留 / 重构收拢 / 清理移除”边界，作为下一阶段 V1 工程实施的直接依据。

当前仓库存在明显的双轨与膨胀问题：上游 **GitHub Ticket 编排** 与 **Agent Studio** 共存，而 `src/managed-worker/` 在早期实验过程中膨胀到了 79 个文件、1.6 万余行，绝大部分是在为“版本化受管文档沙盒、强制无工具纯文本委派、碎片化正则意图”维护状态机，反过来拖住了真正有用的本地工作区执行与日常闭环。

下一阶段的原则是：**保留上游模块不动、留住 Studio 好用的骨架、大刀阔斧砍掉过度设计的玩具包袱。**

## 1. 上游 GitHub Ticket 编排（保持独立共存）

| 路径 | 决策 | 说明 |
| --- | --- | --- |
| `src/index.ts`、`src/core/`、`src/app/`、`src/client/`、`src/executor/`、`src/sources/`、`src/infra/`、`src/admission.ts` 等 | **完整保留** | 可选的 GitHub Ticket 编排服务，不改动其核心行为与既有测试。 |
| `prompts/`、`docs/000`–`docs/008`、`SETUP.md`、`README.md` | **保留并同步** | `docs/007-architecture.md` 的模块表与测试表需在代码增删时同步更新（受 `tests/docs.spec.ts` 校验）。 |
| `scripts/agent-studio` | **保留并借鉴** | 现有单 profile 服务控制脚本（`start / stop / restart / status`、PID 校验、tmux 复用与健康检查）可保留，并作为 V1 自举安全更新/重载的参考或基础。 |

## 2. Agent Studio 保留并演进的骨架

| 模块 | 当前价值 | V1 演进方向 |
| --- | --- | --- |
| `src/studio/service.ts`、`sessions.ts`、`http.ts`、`protocol.ts`、`store.ts`、`domain.ts`、`pending.ts`、`models.ts` | 统一入口、隐式 Session 封装、并发对话、待办状态与 HTTP API 骨架。 | 补齐**统一任务账本**、**项目生命周期（目标/工作区/归档）**与**飞书指名项目路由**；松绑 Assistant 简单问题直接回复；收缩 `service.ts` / `owner-text.ts` 中过度堆叠的正则控制分支。 |
| `src/studio/feishu.ts`、`feishu-setup.ts`、`feishu-sdk.ts`、`feishu-binding.ts` | 官方 `@larksuiteoapi/node-sdk` 长连接、私聊白名单验证、跨端消息/话题/卡片同步。 | 强化飞书消息受理状态回执与指名项目交办，彻底删除另外两套旧版互斥飞书收件箱。 |
| `src/studio/configuration.ts`、`settings-credentials.ts`、`settings-directory.ts`、`settings-protocol.ts`、`settings-schema.ts` | Web 化 Studio 设置、DSH 凭据存储、数据目录安全切换。 | 精简配置 schema，移除旧版文档/旧飞书/Watchdog/systemd 等 V1 废弃开关，新增本地执行默认策略与自举更新相关配置。 |
| `src/studio-web/*` | 独立左侧栏入口、Assistant/项目对话、引用与话题、待我处理、只读会话记录、Studio 设置与飞书引导。 | 保留整体界面骨架，补齐**任务列表与详情面板**、**项目创建/编辑/工作区绑定/归档**、**自举更新触发与状态展示**；清理设置页中的废弃分类。 |

## 3. 需要重构收拢的模块（`src/managed-worker/` 减负）

| 现有文件 | 现状问题 | 重构目标 |
| --- | --- | --- |
| `src/managed-worker/index.ts`（736 行） | `Config` 暴露 20+ 互斥开关，混合挂载 15+ 实验子服务，且写死所有角色为 `read-only` + `allow: []`。 | 收敛 `Config` 为 V1 必需配置；保留单所有者宿主检查、目录锁与 `tools.guard` 机制，改为支持 **Assistant / Leader / 本地工作区 Worker** 的清晰角色与分级权限控制。 |
| `src/managed-worker/store.ts`（1,926 行）、`project-store.ts`（1,485 行） | 巨型单文件耦合了受管文档、行级授权、移交仪式、偏好引用、长作业候选等全部状态。 | 拆分为职责单一、结构简洁的存储模块：项目与工作区表、统一任务表、待办确认表、项目档案与基础偏好表。 |
| `src/managed-worker/assistant.ts`、`project.ts` | 绑定在“纯文字无工具 Worker”与“文档待办”模型上。 | 演进为面向**本地工作区执行**与通用任务的委派/调度层，支持按任务分配只读或读写检查能力。 |
| `src/managed-worker/memory-store.ts`（826 行）、`memory.ts`、`project-archive*.ts` | 为偏好引用、事实引用、失效传播、Bot 经验耦合了大量表与校验。 | V1 精简为**项目档案** + **全局/项目显式偏好**的简洁存取，保留扩展字段供 V3 演进。 |
| `src/managed-worker/text-worker-model-policy.ts` | 仅面向纯文字 Worker。 | 简化并泛化为统一的 Worker 模型配置与角色默认模型策略。 |

## 4. 明确清理移除的历史包袱

以下模块属于早期实验的玩具沙盒、已废弃的旧模式或过早实现的高阶半成品。全部历史代码已保存在 Git 提交记录中，V1 重构时直接清理，待 V2/V3 真正需要时再按清晰架构重建：

| 类别 | 拟清理文件 | 清理理由 |
| --- | --- | --- |
| **受管文档玩具沙盒与相关守卫/恢复链** | `document-command.ts`、`document-guard.ts`、`document-guard-store.ts`、`document-guard-review.ts`、`document-guard-review-store.ts`、`document-continuation.ts`、`document-continuation-intent.ts`、`document-continuation-store.ts`、`document-recovery.ts`、`document-recovery-store.ts`、`document-failure-notices.ts`、`document-failure-notice-store.ts`、`document-intent.ts`、`instructions.ts`、`instruction-store.ts`、`shared-document-store.ts`、`project-document-store.ts`、`project-document-decision-store.ts`、`project-handoff.ts`、`project-handoff-store.ts` | 用“受管单文档行级写入”替代真实本地工作区执行，造成了最大的复杂度倒挂；项目移交简化为直接切换当前 Leader。 |
| **旧版互斥飞书收件箱** | `feishu-inbox.ts`、`feishu-text.ts`、`feishu-draft-store.ts`、`feishu-delivery-store.ts` | 已被统一的 `feishuConversation`（`src/studio/feishu.ts`）取代，继续保留只会导致配置互斥与维护分裂。 |
| **过度碎片化的偏好/事实/经验子模块** | `preference-intent.ts`、`preference-intake.ts`、`preference-proposal-store.ts`、`preference-query.ts`、`preference-query-intent.ts`、`preference-correction.ts`、`preference-correction-intent.ts`、`preference-correction-store.ts`、`preference-scope-change-intent.ts`、`preference-scope-change-store.ts`、`draft-preference-request.ts`、`draft-preference-store.ts`、`memory-citation-store.ts`、`project-fact-intake.ts`、`project-fact-request.ts`、`project-fact-use-store.ts`、`project-result-use-store.ts`、`bot-experience.ts`、`bot-experience-store.ts` | 仅偏好与引用就拆出 19 个高度相似的文件并重度依赖中文正则；V1 替换为简洁的偏好与档案接口，V3 再做系统化经验治理。 |
| **V1 暂不维护的早期半成品子系统** | `study.ts`、`study-store.ts`、`systemd-job.ts`、`project-job.ts`、`project-job-store.ts`、`project-job-monitor.ts`、`project-job-auto-store.ts`、`project-job-candidate-store.ts`、`project-job-start-store.ts`、`quota.ts`、`quota-store.ts`、`quota-notices.ts`、`quota-notice-store.ts`、`watchdog.ts`、`watchdog-store.ts`、`advisor.ts`、`advisor-store.ts`、`project-dispatch-diagnosis.ts`、`project-work-block-store.ts`、`project-work-model-store.ts`、`project-work-termination-store.ts`、`owner-confirmation.ts`、`owner-inbox-input.ts`、`result-tool-names.ts`、`src/studio/revision-store.ts`、`src/studio/router-work.ts` | 与受管文档/纯文本模型深度耦合，且对应能力已明确排入 V2/V3；先清出主干可大幅降低配置、数据库与测试维护成本。 |

## 5. 同步推进的工程治理项

1. **理顺 `cordis.patch.yml` 预设**：将 `agent-studio-managed-worker` 预设从“仅限受管文档、无 shell/无文件写入”演进为支持受控本地工作区工具的 **Agent Studio Worker** 预设，并清晰标注其与上游 Ticket 预设（`agent-studio-worker` / `agent-studio-router`）的区别。
2. **对齐 DSH 版本契约**：核对 `package.json` 中的 `@deepseek-ai/dsh-*` 依赖版本与实际运行宿主（当前为 `0.2.2-rc.x`）的接口契约，消除靠 `as ManagedHost` 盲猜内部字段带来的运行期风险。
3. **统一代码注释与测试资产**：清理残留的中英文混杂代码注释；移除与已废弃模块强绑定的旧测试，围绕 V1 真实闭环（本地工作区读写检查、越界拦截、统一任务视图、飞书指名项目、自举更新与回滚）建设精简高价值的测试套件。

## 6. 建议实施顺序

1. **阶段 1 · 做减法与稳骨架**：清理第 4 节历史包袱，收敛 `Config`、SQLite 表结构和 `cordis.patch.yml`，保持 `pnpm check` 绿灯且上游 Ticket 测试不受影响。
2. **阶段 2 · 打通本地工作区执行**：实现 Worker 的只读调查、受控修改与本地检查能力，落地工作区路径校验、分级权限档位与宿主越界/高危拦截。
3. **阶段 3 · 闭环交互与管理**：补齐统一任务列表/详情、项目生命周期（目标/工作区/归档）、飞书指名项目路由、基础项目档案与偏好，并松绑 Assistant 简单问题直接回复。
4. **阶段 4 · 自举无缝更新与现场验收**：落地本仓库的安全构建、安装/重载与失败回滚闭环，并按 [V1 验收清单](v1-scope.md#8-v1-验收清单)完成真实环境现场验收。
