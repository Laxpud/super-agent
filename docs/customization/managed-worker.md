# 受管文档 Worker（实验入口）

这条入口只管理数据库里的单份文档，不接管 GitHub Ticket，也不能写普通工作区文件。原型的 GitHub、飞书和执行器预设维持原有行为。受管入口及其配套预设默认关闭。

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
```

在新的普通会话中选择 **SuperAgent managed document Worker** 预设。不要在原型的旧 Worker 或 DSH 子代理会话上使用这条命令。受管 Worker 使用只读沙箱和原生执行器，写入只能通过宿主注册的 `studio_write_document` 动作。

## 授权、暂停和移交

1. **登记一条确切授权。** 在 Worker 会话中提交 `/studio-doc start {"initial":"旧正文","replacement":"获准的新正文"}`。回执包含任务 ID、执行轮次、授权版本和文档版本。之后可用普通消息安排 Worker 提交这次修改。只有登记的新正文与预期文档版本 `1` 完全匹配时，动作才可能把文档更新到版本 `2`。普通聊天文本不增加权限。
2. **暂停和查看状态。** 在当前 Worker 会话中提交 `/studio-doc pause`。收到 `Pause effective` 时，暂停与新授权版本已经提交。随时可用 `/studio-doc status` 查看状态，不会返回正文。若回执说暂停未保存，宿主仍阻止该任务写入，而且不提供可用的恢复版本；可重试暂停，或在宿主重启后重新打开会话查看状态。
3. **移交到新 Worker。** 新建一个尚未绑定任务的同预设会话，在那里提交 `/studio-doc transfer <任务ID> <当前执行轮次>`。移交保留已登记的文档内容范围和暂停状态；旧会话不能再写入。
4. **恢复暂停的任务。** 核对任务和写入范围后，在当前 Worker 会话中提交状态或移交回执给出的 `/studio-doc resume <授权版本>`；过时的版本不能恢复写入。收到 `Execution resumed` 只表示重新允许写入，不会自动重跑动作。如果原动作已被拒绝，还要用普通消息让 Worker 继续。

## 宿主重启

受管入口在接收动作前，先把本次运行登记为未确认结束。只有停止接收动作且没有未确认的暂停时，才登记为正常关闭。若暂停保存失败后退出、进程异常退出，或首次打开缺少关闭记录的旧实验数据库，宿主无法从数据库判断哪些待写任务受影响。它在开放动作前暂停所有仍待写且未暂停的任务，提高其授权版本，并单独记录这些系统暂停。已提交的文档和已暂停的任务保持不变；若恢复事务也写不进去，受管入口不会启动。重启本身不会重新放行写入。

该入口只支持由一个宿主保护的 SQLite 文档，不支持多个宿主共用状态目录或恢复已经回退的数据库。它不会主动从 GitHub 或飞书接单，不自动迁移旧会话，也不启动长作业。
