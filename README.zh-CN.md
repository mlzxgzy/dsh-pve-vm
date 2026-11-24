# pve-vm-recorder

[English](README.md) | **简体中文**

一个 DeepSeek Harness (DSH) 插件：让 agent **看见并操作一台 Proxmox VE 虚拟机** —— 截图、连拍录制、取帧、点击、输入文字、按键、在 guest 里跑 PowerShell、回滚快照 —— 全程不用手写一条 `ssh` 命令。

为"agent 必须看着 Windows 虚拟机的屏幕动手"这个场景而写：每一处设计都在守三件事 —— **返回值有界、失败能自解释、动作可撤销**。

```
pve_vm_status      这台 VM 在哪、guest agent 活着没有、有没有录制在跑
pve_screenshot     宿主侧 QMP 取一帧 → 本地 JPEG，只回路径和字节（默认绝不给 base64）
pve_burst          后台按 N fps 连拍进节点 tmpfs，到点自己停
pve_fetch_frames   按序号区间把帧拉回本地并转码，附带真实帧间隔
pve_click          在屏幕坐标点点一下（14 步平滑移动，不是瞬移）
pve_type           发文字（SendKeys，特殊字符已转义）
pve_key            按一个键或组合键（ctrl+a、alt+f4、f5 …）
pve_guest_exec     经 QEMU guest agent 在 guest 里跑 PowerShell
pve_snapshot       回滚到某个快照、重启、并等 guest agent 就绪
```

## 什么都不写死

包里没有任何集群地址、VMID 或快照名。

| 要确定的东西 | 怎么确定 |
| --- | --- |
| 用哪台宿主 | 调用时给 `node:"pve04"`（ssh 别名**或**地址），否则 `PVE_HOSTS`，否则 settings 的 `hosts` |
| VM 属于哪个节点 | 调用当下对每个候选宿主跑 `qm status` —— 迁移过的 VM 是"查到"的，不是"假设"的 |
| 操作哪台 VM | `vmid`，否则 `defaultVmid`，否则**唯一在跑**的那台；多台在跑则失败并返回 `AMBIGUOUS_VMID` 与候选列表 |
| 允许碰哪些 VM | `allowedVmids` 是**可选**限制，留空 = 不限制 |

## 安装

```bash
plugin_manager install_bundle target=/abs/path/to/pve-vm-recorder
# 或者：Settings → Plugins → Add plugin → 选这个目录
```

随包的 `cordis.patch.yml` 插入条目时**不带任何 config**，所以装完什么都不会发生，直到你告诉它要操作哪台机器：

```bash
PVE_HOSTS=pve04,192.168.90.101        # 环境变量
# 或 settings: hosts: ["pve04"]
# 或每次调用:  pve_vm_status {node: "pve04"}
```

前置条件：能 ssh 到 PVE 节点（默认 root）、VM 处于运行状态；`pve_click`/`pve_type`/`pve_key` 还要求 guest 里有已登录的控制台会话（Windows 是 session 1）。

## 失败长什么样

每个工具都返回 `{ok:false, code, message, hint, details?}` 而不是抛异常。常见码：`NODE_NOT_CONFIGURED`、`NODE_UNREACHABLE`（VPN 断了——8 秒返回，不是卡住）、`AMBIGUOUS_VMID`、`QMP_BUSY`、`AGENT_DOWN`、`VM_STOPPED`、`SNAPSHOT_CONFIRM_REQUIRED`、`BRIDGE_TIMEOUT`。

连拍期间的 `QMP_BUSY` 是**策略**不是物理必然：录制器每帧单独连一次 QMP，帧与帧之间 socket 是空的；工具仍然拒绝，只为让"不抢 socket"这件事是确定性的。

## 上手前必须知道的几件事

- **两个会话，两条通道。** `pve_guest_exec` 跑在 session 0（SYSTEM）；点击/输入/按键跑在交互 session 1。在 `pve_guest_exec` 里发 SendKeys 屏幕上什么都不会出现，而输入类工具也跑不了无人值守脚本。
- **`pve_snapshot` 会先把 VM 停掉**（`qm rollback` 要求停机），所以 `agent_up_ms` 量的是"回滚 + 冷启动 + agent 就绪"：40–90 秒。
- **刚回滚或刚开机的 guest 可能什么都不画**：第一帧纯黑（约 12 KB），要有一次真实输入之后桌面才出来。`pve_screenshot {wake:true}` 会识别黑帧并自动点一下。
- **QMP 帧里没有鼠标指针。**
- **一次点击不等于翻一页。** 注入的事件会被批量消费；每次动作后都用截图确认。
- **坐标是屏幕坐标**，不是窗口相对坐标。1280×800 下开始按钮中心约在 (22, 783)。

## 文档

- [docs/DETAIL.md](docs/DETAIL.md) —— 能力与边界、19 项配置、工具表、错误码表、已知限制、与 `prototype/pve` 脚本的对应关系。
- [docs/SELFTEST.md](docs/SELFTEST.md) —— 每条验收都记了实际跑的命令和结果，包括过程中挖出的两个真 bug。

## 许可证

MIT
