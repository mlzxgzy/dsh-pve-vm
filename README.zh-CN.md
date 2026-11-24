# dsh-pve-vm

[English](README.md) | **简体中文**

一个 DeepSeek Harness（DSH）插件：让 agent **操作 Proxmox VE 集群**——先盘点集群与资产，再看屏幕、动鼠标键盘：截图、连拍、取帧、点击、输入、按键、guest 内 PowerShell、回滚快照，全程不用手写一条 `ssh`。

PVE 里的"一台机器"其实是"一个集群"，所以连接的单位就是集群：一次 `ssh` 拿到 节点名 → 管理地址 的映射、quorate、每台 VM、每个存储池。主机和 VMID 都**不写死**。

```
pve_cluster_status  仲裁状态、每节点 cpu/内存/VM 数、集群合计——一次 ssh
pve_cluster_assets  按节点/类型/状态/名字过滤 节点、VM、存储，输出有界
pve_vm_status     VM 在哪台节点、guest agent 活着没、有没有连拍在跑
pve_screenshot    宿主 QMP 取帧 → 本地 JPEG，只给路径和字节数（默认不给 base64）
pve_burst         后台连拍 N fps，帧写节点 tmpfs，自带时长上限
pve_fetch_frames  按区间取回并转码，附真实帧间隔
pve_click         按屏幕坐标点击（14 步平滑移动）
pve_type          发文本（SendKeys，已转义）
pve_key           按一个键或组合键（ctrl+a、alt+f4、f5…）
pve_guest_exec    经 QEMU guest agent 在 guest 内跑 PowerShell
pve_snapshot      回滚到快照、重启、等 agent 就绪
pve_vm_power      开机 / 关机 / 优雅关机 / 重启 / 硬复位，并等到目标状态
pve_sendkey       经 QMP 直接按键（qm sendkey），不需要 agent、不需要会话
pve_vm_config     核数、内存、磁盘、网卡、启动顺序、快照、guest IP 与系统
pve_vm_snapshot   快照 列表 / 创建 / 删除 / 回滚（回滚需 confirm）
pve_task          节点任务队列：列表、状态（可等待）、日志尾部
pve_storage_content  存储池，或某个池里的 ISO / 模板 / 备份 / 磁盘卷
pve_vm_migrate    把 VM 迁到集群另一节点（在线或离线），并回报它现在在哪
pve_vm_clone      从 VM 或模板克隆成新 id，可指定目标节点/存储
pve_vm_delete     销毁 VM（confirm:true；运行中的要 stop:true）
```

## 没有写死任何东西

包里不含集群地址、节点名、VMID、快照名。

| 要回答的事 | 怎么解析 |
| --- | --- |
| 从哪台机器问 | 调用参数 `node:"pve04"`（**ssh 别名或地址**），否则 `PVE_HOSTS`，否则设置里的 `hosts` |
| 集群是什么样 | 读 `/etc/pve/.members` + `pvecm` + `pvesh get /cluster/resources`，一次取全量，缓存 15 s |
| 节点名 → 地址 | `.members` 里的 `ip`（`pve04` 在 DNS 里解析不了，`ssh root@pve04` 直接失败） |
| VM 属于哪台节点 | 集群清单；拿不到就逐候选跑 `qm status`——迁移过的 VM 是查出来的，不是猜的 |
| 操作哪台 VM | `vmid`，否则 `defaultVmid`，否则集群里**唯一 running** 的那台；多台在跑就报 `AMBIGUOUS_VMID` 并列出候选 |
| 允许碰哪些 | `allowedVmids` 是**可选**限制（空 = 不限制） |

`clusterMode` 决定依赖多硬：`auto`（默认，先试集群，失败退回逐主机 `qm list`）、`on`（必须是集群）、`off`（从不读集群）。集群侧**只读**：不创建、不迁移、不销毁。

## 安装

```bash
plugin_manager install_bundle target=/abs/path/to/dsh-plugin/dsh-pve-vm
# 或：Settings → Plugins → Add plugin → 选这个目录
```

随包的 `cordis.patch.yml` **不写 config**，所以装完什么也不会发生，直到你告诉它连哪台：

```bash
PVE_HOSTS=pve04,192.168.90.101        # 环境变量
# 或设置：hosts: ["pve04"]
# 或每次调用：pve_cluster_status {node: "pve04"}
```

需要：能 ssh 到一台 PVE 节点（默认 root）、有一台 running 的 VM；输入类工具还要求控制台会话已登录（Windows 是 session 1）。

## 失败长什么样

所有工具都返回 `{ok:false, code, message, hint, details?}`，不抛裸异常。常见码：`NODE_NOT_CONFIGURED`、`NODE_UNREACHABLE`（VPN 断了——8 s 返回，不是卡住）、`AMBIGUOUS_VMID`、`QMP_BUSY`、`AGENT_DOWN`、`VM_STOPPED`、`SNAPSHOT_CONFIRM_REQUIRED`、`BRIDGE_TIMEOUT`。

连拍期间的 `QMP_BUSY` 是**策略**，不是物理必然：录制器每帧连一次 QMP 就关，帧之间 socket 是空闲的；工具层仍然拒绝，是为了让"别抢 socket"这件事确定。

## 用之前值得知道的几件事

- **列表都有界。** `pve_vm_status` 最多列 25 台（running 优先）再加一句 `… and N more`；`pve_cluster_assets` 默认 40 条但 `counts` 是全量；276 台的集群不会把上下文刷满。`sort`/`order` 先排序再截断，所以 `{sort:"mem", order:"desc", limit:5}` 真的是最大的 5 个。
- **`node` 是种子，`on` 是过滤。** `pve_cluster_assets {node:"192.168.90.104", on:"pve04"}` = 找 pve04 的地址问、只要 pve04 上的东西。
- **两个会话，两条通道。** `pve_guest_exec` 在 session 0（SYSTEM）；点击/输入/按键在交互 session 1。在 `pve_guest_exec` 里调 SendKeys 屏幕上什么都不会发生，输入类工具也跑不了无人值守脚本。
- **`pve_snapshot` 会先把 VM 停掉**（`qm rollback` 要求停机），所以 `agent_up_ms` 是"回滚 + 冷启动 + agent 就绪"的合计量：40–90 s。
- **刚回滚或刚冷启动的 guest 可能什么都不绘制**：第一帧是纯黑（约 12 KB），一次真实输入之后桌面才出现。`pve_screenshot {wake:true}` 会检测并点一次。
- **QMP 帧不含鼠标指针。**
- **一次点击不等于前进一页。** 注入事件会被批量消费，动作之后一定要截图确认。
- **坐标是屏幕坐标**，不是窗口相对坐标。1280×800 下任务栏"开始"按钮中心约 **(22, 783)**。

## 文档

- [docs/DETAIL.md](docs/DETAIL.md) — 能力、集群连接模型、21 项配置、工具表、错误码表、已知限制、以及和 `prototype/pve` 脚本的对应关系。
- `npm test` — 用真实集群采样做夹具，验证集群解析与 `clusterMode` 三档行为（`dev/test-cluster.mjs`）；`npm run test:wire` 检查 11 个工具定义可加载。
- [docs/SELFTEST.md](docs/SELFTEST.md) — 每条验收实际跑过的命令与结果，包含过程中发现的真 bug。

## 许可

MIT
