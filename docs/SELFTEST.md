# 自测记录（pve-vm-recorder v1.0.0）

环境：本机 DSH Desktop（profile `desktop`），PVE 节点 `pve04 = 192.168.90.104`，目标 VM `15047`
（Windows Server 2016，1280×800，快照 `init`）。全部工具调用走**已安装的插件**（不是 dev 脚本），
时间 2026-11-24 13:30–13:45（Asia/Shanghai）。

安装结果（`plugin_manager action=install_bundle target=/data1/01-AiWork/jev研究/dsh-plugin/pve-vm-recorder`）：

```
{"stage":"enable","target":"pve-vm-recorder","enabled":true,"changed":true,
 "application":"applied","bundle":"pve-vm-recorder","version":"1.0.0","warnings":[]}
```

9 个工具在会话里出现；`pve_guest_exec` 受 `allowGuestExec` 门控（`dev/wire.mjs` 断言
`when()` 在 true/false 下分别为 true/false，输出 `WIRING OK`）。

---

## 验收逐条

### 1) `pve_snapshot` 回滚 `init`，`agent_up_ms` 有值 —— 通过

| 调用 | 结果 |
| --- | --- |
| `pve_vm_status` | `VM 15047 on 192.168.90.104: running; guest agent ok (997 ms)` |
| `pve_snapshot {confirm:true, snapshot:"init"}` | `rolled back to 'init' and booted. rollback 1.2 s; guest agent up 45.2 s after start; total 53.7 s` |

返回值里 `snapshot:"init"`、`previous_status:"running"`、`rollback_ms:1200`、`agent_up_ms:45200`。
快照列表只有 `init`（`qm listsnapshot` 原始输出里另有 `current` 游标，解析时跳过）。
就绪判定用 `qm agent <vmid> ping` 的 **exit code**——本版 PVE 成功时 stdout 为空，grep 文本会永远等下去。

### 2) `pve_screenshot` 出 1280×800 且肉眼可见 —— 通过（附一个真限制）

```
pve_screenshot {name:"a3-after-click"}
→ /data1/01-AiWork/jev研究/pve-rec/v15047/shots/a3-after-click.jpg
  1280x800 jpeg, 113064 bytes; screendump 8 ms, total 2.2 s; encoder ffmpeg
```

打开图片确认：Windows Server 2016 蓝桌面、任务栏、中文"服务器管理器"仪表板、右下角 `13:36 / 2026/11/24`。

**但回滚后第一张是黑的**：`pve_screenshot {name:"a2-desktop"}` → 1280×800、**12,203 B 全黑**。
同时用 `pve_guest_exec` 查 guest：`SESSION=0`、显示适配器 1280×800 正常、`EXPLORER=1:3300`、
`quser` → `administrator console 1 Active 2026/11/24 13:30`。桌面在，黑的是扫描输出。
一次真实 session-1 输入之后，同尺寸截图变成 113,064 B 正常画面。→ 已写入 DETAIL 限制 9。

### 3) `pve_click` 后画面确实变了 —— 通过

| 调用 | 结果 |
| --- | --- |
| `pve_click {x:222, y:309}` | `clicked 222,309 with {X=22,Y=309}`，3.0 s |
| `pve_screenshot {name:"a3-local-server"}` | 1280×800 jpeg 103,207 B |

画面从"仪表板"切到"本地服务器"：左栏选中项高亮、右侧出现计算机名 `WIN-3V53K6O92L0`、
工作组 `WORKGROUP`、Windows 防火墙 公用/启用、远程桌面 已启用 —— 确实变了，且点击坐标精确命中左栏项。

反向证据：`pve_click {x:22,y:770}` 与 `{x:22,y:758}` 都返回 `clicked`，但截图里**开始菜单没有打开**；
改成 `{x:22,y:783}` 后立刻打开（可见磁贴、拼音 IME、左侧应用列表）——同尺寸下开始按钮中心就在 **(22,783)**。
→ 已写入 DETAIL 限制 11（坐标要按截图量）。

顺带把 `pve_type` / `pve_key` 也压了一遍：开始菜单打开时 `pve_type {text:"notepad"}` → `typed 7 characters`（4.1 s），
再截图可见搜索框里是 `notepad`、最佳匹配 `记事本`；`pve_key {key:"esc"}` → `pressed {ESC} × 1`（3.3 s）。

### 4) `pve_burst` 4 fps × 20 s → 取帧 ≈80、帧号连续、p50≈250 ms —— 通过

```
pve_burst {action:"start", fps:4, seconds:20}
→ pid 588786, dir /dev/shm/pve-rec/v15047/burst, deadline …05:38:03.549Z
pve_fetch_frames {max:100}
→ 81 frames (0…80) → /data1/01-AiWork/jev研究/pve-rec/v15047/frames
  interval p50 250 ms, p95 251 ms; indices contiguous; total 24.5 s
```

节点侧真值（`times.csv` 82 行，`meta.json`）：

```
n 81  first 7 ms  last 20006 ms  p50 250  p95 251  min 248  max 252
{"frames":81,"fps":4.0,"seconds":20.0,"elapsed_ms":20006,"error":null}
```

20 s × 4 fps = 80 帧，实测 81（第 0 帧在 t≈7 ms）。产物归档在 `pve-rec/v15047/frames-a4/`。

### 5) 连拍中调 `pve_screenshot` 立即 `QMP_BUSY`，不卡 —— 通过

```
pve_screenshot {name:"a5-during-burst"}
→ FAILED QMP_BUSY: a frame recorder is running for VM 15047 (60 frames recorded);
  QMP accepts a single client
  hint: A burst is stopped with `pve_burst action:"stop"`; this call did not wait and
        did not steal the socket.
  details: {"frames":60,"burst":true}
```

即时返回（无等待、无"帮忙"杀别人的录制器）。注意这是**工具层策略**：录制器每帧连一次 QMP 就关，
帧间 socket 空闲，所以直接走 QMP 也能截到图——这一条写进了 DETAIL 限制 1，避免下一个人误以为是物理互斥。

### 6) `pve_guest_exec` 跑 `(Get-WindowsFeature Web-Server).InstallState` —— 通过（值与环境描述不符）

```
pve_guest_exec {script:"\"WEB-SERVER: \" + (Get-WindowsFeature Web-Server).InstallState …"}
→ exit 0 in 5.9 s
  WEB-SERVER: Available
```

**实际值是 `Available`（未安装），不是任务书/playbook 里的 `Installed`。** 回滚到 `init` 后
IIS 尚未安装，`Get-Service W3SVC` 也为空 —— 环境事实里那条 "Installed/Running" 属于"装完之后的终态"。
按任务要求，这里记录实际值，不改代码去凑。

### 7) `pve_guest_exec` 查 `Get-NetFirewallRule Demo-8080` —— 通过（记录实际值：不存在）

```
DEMO-8080: absent (CmdletizationQuery_NotFound_DisplayName,Get-NetFirewallRule)
W3SVC:
SESSION: 0
USER: SYSTEM
```

回滚后的 `init` 快照里没有 `Demo-8080` 入站规则（也没有 IIS）。同样是"终态才有的资源"。
顺带确认：`pve_guest_exec` 跑在 **session 0 / SYSTEM**，与 `pve_click` 的 session 1 是两条通道。

### 8) 取消 burst 后节点上无残留循环 —— 通过

```
pve_burst {action:"start", fps:4, seconds:30}   → pid 590197
pve_burst {action:"stop"}                       → recorder stopped after 200 ms; 35 frames
ssh pve04 'ps -ef | grep "[r]ecorder"'          → none
ssh pve04 'ls /dev/shm/pve-rec/v15047/burst'    → pid 与 STOP 都已删除
cat meta.json → {"frames":35,"fps":4.0,"seconds":30.0,"elapsed_ms":8507,"error":null}
```

停法：`touch STOP` → 录制器自己在帧边界退出（实测 200 ms）→ 插件再轮询 pid、必要时 TERM/KILL。
`seconds` 上限同样兜底（调用方消失也不会永久跑）。自然结束（第 4 条 20 s 那次）后同样是 0 个残留进程。

---

## 附带验证

| 项 | 结果 |
| --- | --- |
| 取帧写 sidecar | `frames/` 里除 35 张 JPEG 外，还有 `times.csv`（原始时间戳）与 `frames.json`（`count:35`、`missing:[]`、`timing`） |
| 失败可读 | 每次失败都是 `{ok:false, code, message, hint, details?}`；`details` 承载帧数/耗时/审计路径（严格 schema 下不能平铺） |
| 审计日志 | `pve-rec/audit.jsonl`：每次 `pve_guest_exec` 一条，含 `ts/vmid/node/script`（脚本原文） |
| 输出有界 | 截图只回路径+字节（`inline:false`）；`pve_guest_exec` 超 8 KB 截断并标 `truncated` |
| 代码健康 | `npm run check`（19 个文件的 `node --check`）全过；`dev/wire.mjs` 输出 `WIRING OK` |

## 未验证 / 未覆盖

- **多节点**：只对 `pve04` 跑过。`nodes` 白名单里有多个节点时的“并行探测 + 60 s 缓存”只有代码路径，无真机证据。
- **VPN 断线**：`NODE_UNREACHABLE` / `SSH_TIMEOUT` 的文案是设计值，未在断网状态下实测。
- **大录制区间**：只跑到 81 帧；`from/to` 分段与 `max` 截断在 3000 帧量级下未压测。
- **`pve_type` 的长文本**：只验过 7 个字符（`notepad` 落进开始菜单搜索框）；2000 字符上限、以及
  `+ ^ % ~ ( ) { } [ ]` 这类需要转义的字符没有逐字符核对。
- **中文字符输入**：`SendKeys` 走的是键盘布局，中文需要剪贴板或 IME 路径，v1 不支持。

---

# v1.1.0 复测（2026-11-24 下午）

改动主题：**不写死任何地址/VMID**、去掉白名单式硬限制、`wake` 黑屏唤醒、边录边取、每个版本一个 commit。
环境：本机 → VPN → pve04 `192.168.90.104`（VM 15047 Windows Server 2016）；pve01 `192.168.90.101` 仅用于多节点发现。

| # | 项目 | 命令 | 实测结果 | 判定 |
| --- | --- | --- | --- | --- |
| V1 | 无任何配置时的失败是否自解释 | `pve_vm_status {vmid:15047}` | `FAILED NODE_NOT_CONFIGURED: no PVE host is configured and none was passed on the call`，hint 给出三条路（`node` / settings `hosts` / `PVE_HOSTS`） | 通过 |
| V2 | 任意 host + VM 自动发现 | `pve_vm_status {node:"192.168.90.104"}` | `192.168.90.104 → pve04`，列出 84 台（83 stopped + 15047 running），并提示"A call without vmid would use VM 15047" | 通过 |
| V3 | 换一个节点也认 | `pve_vm_status {node:"192.168.90.101"}` | `→ pve01`，23 台 running（1001/1002/1003/15019…15199/336699），`qm list` 五列解析正确 | 通过 |
| V4 | 断网 | `pve_vm_status {node:"192.168.90.199"}` | 约 8 s 后 `FAILED NODE_UNREACHABLE: … ssh: connect to host 192.168.90.199 port 22: Connection timed out`，details.hosts 带每台的回显 | 通过 |
| V5 | 回滚（不写死 vmid/节点） | `pve_snapshot {node:"192.168.90.104", vmid:15047, snapshot:"init", confirm:true}` | `rolled back VM 15047 on pve04 to snapshot "init" and booted it. rollback 1.1 s; stop 2.1 s; guest agent up 40.1 s after start; total 47.8 s` | 通过 |
| V6 | 截图（回滚后） | `pve_screenshot {node, vmid, name:"v11-wake-after-rollback", wake:true}` | 1280×800 jpeg 48,166 B，`woke` 未触发（Windows 已合成）；另一次 113,297 B / 115,492 B 正常桌面 | 通过 |
| V7 | 黑帧判定（真实帧回归） | 用 `parsePpm`+`blankness` 跑本地解码的 `v11-black.jpg` 与 `v11-wake-idle.jpg` | 黑帧 `blank=true min=0 max=0 mean=0.0`；正常帧 `blank=false min=0 max=255 mean=90.0` | 通过 |
| V8 | 点击（`clicks` 缺省路径） | `pve_click {node, vmid, x:640, y:400}` | `clicked 640,400 on VM 15047 in 3.0 s` —— 这正是 v1.1.0 之前 100% 超时的那条路径 | 通过 |
| V9 | 连拍 24 s @4fps | `pve_burst {node, vmid, action:"start", fps:4, seconds:24}` | pid 612384，`meta.json` = `{frames:97, fps:4, seconds:24, elapsed_ms:24008, error:null}` | 通过 |
| V10 | **边录边取** | 录制中 `pve_fetch_frames {node, vmid, from:0, to:11, max:12}` | 12 帧（0…11）取回，`interval p50 250 ms / p95 251 ms`，`contiguous`，总 4.0 s —— 录制仍在进行 | 通过 |
| V11 | 区间续取 + 收尾 | `pve_fetch_frames {node, vmid}`（录制结束后，取到 0…79）；再 `{from:80}` | 17 帧（80…96），`contiguous`，合计 97 帧与 `meta.json` 一致 | 通过 |
| V12 | 无残留循环 | 节点 `ps -eo pid,etime,cmd | grep -E "recorder|qmp"` + `ls burst/tmp` | 只有 `/usr/bin/kvm`；`tmp=0`；`pid` 文件已删 | 通过 |

## 本轮修掉的两个真 bug

1. **`BRIDGE_TIMEOUT` 的根因是 `NaN` 进了 PowerShell。** `lib/actions.js` 的点击脚本用 `Math.max(1, Math.min(3, spec.clicks))`，而 `wake` 路径调 `clickScript({x,y})` 不带 `clicks` → `NaN` → 生成的脚本里出现 `for ($c = 0; $c -lt NaN; $c++)`，PowerShell **解析期**即失败；因为跑在隐藏的 session-1 窗口里（`//B` 静默），唯一症状就是 60 s 后 `BRIDGE_TIMEOUT`。把写出的 `run.ps1` 直接在当前会话跑一次才看到真错：`At C:\agent\run.ps1:31 char:20 … Unexpected token 'NaN'`。修法：`Number(spec.clicks ?? 1)` + 有限性判断（附 4 组输入的单测）。附带把 bootstrap 加 400 ms 静置、runner 每 8 s 重发一次 `Run()`，把"启动被吞"变成重试。
2. **`pve_snapshot` 等 stop 永远等不到。** `waitFor` 的谓词写成了 `(await queryVmStatus(...)) === 'stopped'`（拿对象比字符串）→ `stop_ms: 92608` 而 VM 其实早已 stopped。改为 `.status === 'stopped'`。

## 本轮确认的"看起来像 bug 其实不是"

- **计划任务 `State=3 (Running)` + `GetInstances(0).Count=0` + `LastTaskResult=0x0`** 在这台 guest 上会与"任务根本没跑"和"任务已经跑完"同时出现，**不能**用来判断卡死。判断永远看副作用文件（`C:\agent\out.txt`）。
- **从 session 0 发 `WM_SYSCOMMAND/SC_MONITORPOWER` 不会让 QMP 帧变黑**（VGA 保留最后合成帧），所以黑屏只能等 DPMS 超时或冷启动未绘制。

## v1.1.0 仍未验证

- 3000 帧级长录制的分批取帧（只测到 97 帧）。
- 中文/emoji 的 `pve_type`（SendKeys 走键盘布局，中文需要 IME，未测）。
- 长文本与 `+^%~(){}[]` 转义的端到端效果（只做了单测级验证）。
- 多台 VM 同时 running 时 `AMBIGUOUS_VMID` 的真实触发（当前集群恰好只有一台 running）。
- 除 pve01/pve04 之外的 PVE 版本（`qm list` 列格式假设）。
