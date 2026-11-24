# pve-vm-recorder

把 `prototype/pve/` 里跑通的 PVE 观测/控制脚本做成 DSH 工具：**截图、连拍、取帧、点击、输入、按键、guest 内 PowerShell、回滚快照**，不用 bash 拼 ssh。

目标场景是"让 agent 看屏幕并操作一个 Windows 虚拟机"，因此每个设计都围绕三件事：返回值有界、失败可解释、动作可撤销。**没有任何集群地址、VMID、快照名写死在包里**：节点和 VM 都是调一次现查一次。

---

## 1. 能力与边界

**做**：宿主 QMP 截图（不经 guest 桌面合成，可 `wake` 唤醒黑屏）、4 fps 级后台连拍（帧写节点 tmpfs，边录边取）、按区间取帧并给出真实帧间隔、session 1 内点击/输入/按键、guest agent 内执行 PowerShell、回滚到快照并等 agent 重新就绪、**ssh 主机与 VM 自动发现**（`qm list` / `qm status`）。

**不做**：视觉模型、视频合成、UI 面板、多 VM 编排、Linux 目标、把帧直播到本地播放器。

---

## 2. 安装

```bash
plugin_manager install_bundle target=/abs/path/to/dsh-plugin/pve-vm-recorder
# 或在 Web GUI：Settings → Plugins → Add plugin → 选这个目录
```

随包的 `cordis.patch.yml` **只插入条目，不写任何 config**。装完什么事都不会发生，直到你知道该操作哪台机器——三种等价方式，任选一种：

| 方式 | 例子 | 适用 |
| --- | --- | --- |
| 每次调用带 `node` | `pve_vm_status {node:"pve04"}` | 临时用，什么都不用配 |
| 环境变量 | `PVE_HOSTS=pve04,192.168.90.101` | 常驻的机器/ssh 别名 |
| 插件设置 | Settings 卡片里填 `hosts: ["pve04"]` | 固定集群 |

`node` 接受 **ssh 别名或地址**（`pve04`、`192.168.90.104` 都行）。省略 `vmid` 时用 `defaultVmid`，没配就用集群里**唯一 running** 的那台；有多台在跑则报 `AMBIGUOUS_VMID` 并把候选列在 `details.vms` 里，不猜。

卸载：`plugin_manager action=remove_bundle target=pve-vm-recorder`。卸载时会尽力停掉远端录制循环。

---

## 3. 配置项（Settings 卡片 / profile patch 层）

全部可选。**默认值的安全含义写在"说明"列**，不是写在代码里的白名单。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `hosts` | `[]` | 可探查的 ssh 别名/地址。VM 属于哪个节点用 `qm status` **现查**，不写死。空也行——每次调用传 `node` 或设 `PVE_HOSTS`。 |
| `sshUser` | `root` | ssh 用户。 |
| `sshPort` | `22` | ssh 端口。 |
| `sshKeyPath` | `''` | 私钥路径，空则用默认密钥。 |
| `sshConfigFile` | `''` | `ssh -F` 值。默认走标准 `~/.ssh/config`（别名可用）；本机 ssh_config 坏掉时设 `/dev/null` 绕过。 |
| `sshExtraOptions` | `[]` | 追加的 `-o` 选项。 |
| `connectTimeoutMs` | `8000` | ssh ConnectTimeout。 |
| `defaultVmid` | `0` | 不传 `vmid` 时用它；`0` = **自动挑唯一 running 的 VM**。 |
| `allowedVmids` | `[]` | **可选**限制：空 = 不限制。填了就只有这些 VMID 能用。 |
| `tmpfsDir` | `/dev/shm/pve-rec` | 节点上的帧目录根。必须在 tmpfs（`/dev/shm`）上，写盘会拖垮连拍。 |
| `localOutDir` | `pve-rec` | 本地落盘目录（截图/取帧/审计）。相对值按**会话工作目录**解析。 |
| `allowGuestExec` | `true` | 关掉时 `pve_guest_exec` **不出现在工具列表里**（不是调用被拒）。高危能力，但默认开——它就是这套工具的日常用法；每次调用写审计。 |
| `guestTimeoutMs` | `120000` | guest 执行默认超时。 |
| `qmpTimeoutMs` | `3000` | QMP 连接/首帧超时；超时归类为 `QMP_BUSY`。 |
| `burstMaxSeconds` | `60` | 连拍时长上限，防止忘记停。 |
| `maxGuestOutputBytes` | `8192` | guest 输出截断阈值。 |
| `frameFormat` | `jpeg` | 取帧/截图格式，`jpeg` 或 `png`。 |
| `frameQuality` | `4` | JPEG 质量（ffmpeg `-q:v`，2–10）。 |
| `auditLog` | `''` | 审计日志路径，空则 `<localOutDir>/audit.jsonl`；超过 1 MiB 滚动为 `.1`。 |

---

## 4. 工具

九个工具，全部返回 JSON；失败返回 `{ok:false, code, message, hint, details?}`（不抛裸异常）。所有工具都接受 `node`（ssh 别名/地址）。

| 工具 | 主要参数 | 返回 |
| --- | --- | --- |
| `pve_vm_status` | `vmid?`, `node?`, `fresh?` | `vmid,host,node,status,agent,agent_ms,source,burst,frames,hosts,vms,picked,vm_total,vms_truncated,running_count,wall_ms` |
| `pve_snapshot` | `vmid?`, `node?`, `snapshot=init`, `confirm`（必填 true） | `snapshot,previous_status,rollback_ms,stop_ms,start_ms,agent_up_ms` |
| `pve_screenshot` | `vmid?`, `node?`, `name?`, `format?`, `quality?`, `inline?`, `wake?`, `wakeX?`, `wakeY?` | `path,bytes,w,h,format,encoder,blank,woke,ms,wall_ms[,data,encoding,inline_skipped]` |
| `pve_burst` | `vmid?`, `node?`, `action=start\|stop\|status`, `fps=4`, `seconds=20` | `action,dir,local,fps,frames,started_ms,pid,running,was_running,waited_ms,killed,deadline_ms,already` |
| `pve_fetch_frames` | `vmid?`, `node?`, `from?`, `to?`, `max=200`, `format?` | `count,dir,first_index,last_index,first_ms,last_ms,interval_p50_ms,interval_p95_ms,contiguous,missing,skipped,total_on_node,pattern,sample` |
| `pve_click` | `vmid?`, `node?`, `x`, `y`, `button`, `clicks` | `x,y,button,clicks,output,ms` |
| `pve_type` | `vmid?`, `node?`, `text`, `enter?`, `delayMs?` | `chars,enter,output,ms` |
| `pve_key` | `vmid?`, `node?`, `key`, `repeat?`, `delayMs?` | `expression,repeat,output,ms` |
| `pve_guest_exec` | `vmid?`, `node?`, `script`, `timeoutMs?` | `stdout,stderr,exit,truncated,bytes,audit,ms` |

几个刻意为之的行为：

- **`pve_vm_status` 不传 `vmid` 就是集群视图**：running 的 VM 全列，stopped 只列前 12 台并标 `vms_truncated`——一次 `qm list` 在 84 台 VM 的节点上也只占一屏。传了 `vmid` 就只报这一台。
- **`pve_screenshot` 只给路径和字节数**，不塞 base64。`inline:true` 且小于 200 KB 时才附图片，否则返回 `inline_skipped`。
- **`wake:true` 会把黑屏点醒**：截图后判 `blank`（全黑或纯色），若是黑屏就经 session-1 桥在 `(wakeX??1150, wakeY??620)` 点一次、等 900 ms 再截，结果里 `blank:true, woke:true`。默认关——它会在桌面上留下一次点击。
- **`pve_burst` 是后台循环**，帧写节点 `${tmpfsDir}/v<vmid>/burst/`，带 `times.csv`（每帧相对毫秒）和 `meta.json`。它有 `seconds` 上限（默认 20，天花板 `burstMaxSeconds`），即使调用方消失也会自己停。每帧先写 `tmp/` 再原子 rename，所以**录制中取帧拿到的一定是完整 PPM**。
- **`pve_fetch_frames` 支持区间**（`from`/`to`/`max`），3000 帧的录制可以分批取，每批都告诉你 `interval_p50_ms` 和是否 `contiguous`；录制没结束也能取。
- **`pve_snapshot` 要求 `confirm:true`**，并且结果里回显被回滚到的快照名——因为回滚会丢弃当前状态。
- **`pve_guest_exec` 的脚本按原样进滚动审计日志**（`audit.jsonl`），结果里带回日志路径。
- **失败带 `details`。** 严格输出 schema 下没有"随手多塞一个字段"的自由，所以诊断信息（帧数、回滚耗时、审计路径）统一放在 `details` 对象里，`hint` 里给出下一步。

---

## 5. 错误码

| 码 | 含义 | 常见修法 |
| --- | --- | --- |
| `NODE_NOT_CONFIGURED` | 既没有 `hosts`、`PVE_HOSTS`，调用也没带 `node` | 三者任选其一 |
| `NODE_UNREACHABLE` | ssh 连不上（VPN 断了最常见） | 检查 VPN；`ssh -o ConnectTimeout=5 root@<node> true` |
| `AMBIGUOUS_VMID` | 多台 VM 在 running，无法自动挑 | 传 `vmid`；候选在 `details.vms` |
| `VM_NOT_FOUND` | 候选节点上都没有这台 VM | 看 `details.hosts` 的 `qm status` 回显 |
| `VMID_NOT_ALLOWED` / `BAD_VMID` | 被 `allowedVmids` 限制，或不是正整数 | 空列表 = 不限制 |
| `SSH_TIMEOUT` | ssh 命令超时 | 提高 `timeoutMs`；断网时不是插件 bug |
| `SSH_FAILED` | 远端命令非零退出 | 看 `message` 里的远端 stderr |
| `QMP_BUSY` | QMP socket 被占用，或连不上（3 s 超时） | 等 burst 结束；关掉 PVE Web 控制台 |
| `QMP_MISSING` | `/var/run/qemu-server/<vmid>.qmp` 不存在 | VM 没跑，或不在这个节点 |
| `QMP_ERROR` | QMP 返回错误 | 看 `message` |
| `VM_STOPPED` | VM 不 running | `pve_snapshot` 或手动 start |
| `VM_RUNNING` | 想停却停不下来（`qm stop` 90 s 未生效） | 手动 `qm stop <vmid>` |
| `AGENT_DOWN` / `AGENT_TIMEOUT` | guest agent 不回 | 等 30–90 s；刚回滚完尤其慢 |
| `SNAPSHOT_CONFIRM_REQUIRED` | 没给 `confirm:true` | 显式确认 |
| `SNAPSHOT_NOT_FOUND` | 快照名不存在 | 先看 `pve_vm_status`/`qm listsnapshot` |
| `BURST_ACTIVE` / `BURST_NOT_RUNNING` | 已有一个连拍在跑 / 没有可停的 | 先 `action:stop` |
| `BURST_START_FAILED` | 远端录制器起不来 | 看 `message` 里的远端日志尾 |
| `FRAMES_MISSING` | 没有帧可取 | 先 start，再 fetch |
| `GUEST_EXEC_DISABLED` | `allowGuestExec` 被关掉 | 开配置 |
| `GUEST_EXEC_FAILED` | guest 侧仍在跑/失败 | 提高 `guestTimeoutMs` |
| `BRIDGE_FAILED` / `BRIDGE_TIMEOUT` | session-1 桥失败/超时 | 重试；确认 session 1 已登录 |
| `BAD_ARGS` | 参数越界（坐标、fps、脚本长度…） | 看 `message` |
| `CONVERT_FAILED` | PPM 解码或本地编码失败 | 检查本机 ffmpeg/convert |
| `INTERNAL` | 未预期异常 | 附 `message` |

---

## 6. 已知限制

1. **`QMP_BUSY`（连拍期间截图）是工具层策略，不是 QMP 的物理必然。** 录制器每帧连一次 QMP 就关，socket 在帧之间是空闲的——实测连拍进行中直接走 QMP 也能截到图。工具层先查 `burstStatus` 再短路，是为了让"连拍期间不要抢 socket"这件事**确定**，而不是赌 5 ms 的空窗。若真有人长期占着 socket（PVE Web 控制台），QMP 层超时同样给 `QMP_BUSY`。
2. **guest 执行在 session 0（SYSTEM），点击/输入在 session 1（Administrator）。** 两套通道不能混用：`pve_guest_exec` 里调 SendKeys 或桌面 API 什么也看不到；`pve_click`/`pve_type` 想跑无人值守脚本也不行（会话切换用不了）。这就是为什么 `pve_type`/`pve_key` 每次要 2–4 s——它们要经计划任务把脚本投进交互会话。
3. **`pve_snapshot` 会先停 VM**（`qm rollback` 在 running 状态不成立），所以 `agent_up_ms` 是"回滚 + 冷启动 + agent 就绪"的合计量，实测 40–90 s 量级，不是 30 s。等 agent 用 **exit code** 判定，不 grep 文本——本版 PVE 的 `qm agent ping` 成功时没有输出。
4. **QMP 帧不含鼠标指针。** 需要看指针位置时，用 guest 内查询（`[Cursor]::Position`，屏幕坐标）。
5. **连拍的帧在节点 tmpfs 上**，节点重启或换节点就没了；插件不做跨节点同步。
6. **JPEG 编码发生在本机**（ffmpeg → convert → magick 依次尝试），三者都没有时回退成纯 JS PNG（文件后缀会自动变成 `.png`）。节点上没有 PIL/ffmpeg，别指望在那里转码。
7. **一次点击不等于前进一页。** 注入事件会被 Windows 输入栈批量消费，实测一次点击能连过三页。动作后必须截图确认，不要用日志时间戳当"动作完成时间"。
8. **`pve_guest_exec` 的输出是真实输出，但可能被截断**（`maxGuestOutputBytes`，默认 8 KB）；`truncated:true` 时要分批取。单次往返实测 1.8–5.9 s（含 PowerShell 冷启动）。
9. **回滚/冷启动后的头几帧可能是全黑。** guest 里桌面和 explorer 都在（`quser` 显示 console 1 Active），但 Windows 还没往 VGA 扫描输出内容，QMP 截到的是纯黑帧（实测恰好 **12,203 B**，正常桌面 48–119 KB）。`wake:true` 会点一次把它点醒；否则自己 `pve_click` 一下再截。
10. **取帧会在本地多写两个文件**：`times.csv`（节点上的原始时间戳）和 `frames.json`（录制清单：序号、字节、缺失、抓取时间）。这样那批 JPEG 脱离节点也能直接再剪接。
11. **坐标是屏幕坐标，别按窗口相对算。** 1280×800 下任务栏"开始"按钮中心约 **(22,783)**；y=758/770 落在任务栏条上但点不开菜单（实测）。UIA 的 `BoundingRectangle` 同样是屏幕坐标。
12. **自动发现依赖 `qm list` / `qm status` 的文本格式。** 解析器只认 `VMID NAME STATUS MEM(MB) BOOTDISK(GB)` 这五列；PVE 改版换了列序就要跟着改（`lib/nodes.js` 的 `QM_LIST_ROW`）。已实测 pve01（8.2 版）与 pve04 两套输出都认。
13. **ssh 链路的失败与"插件坏了"要分开看。** VPN 断掉的表现是 8 s 后 `NODE_UNREACHABLE`（`ssh: connect to host … Connection timed out`），不是工具超时。

---

## 7. 与参考实现的对应关系

| 本插件 | prototype/pve | 差异 |
| --- | --- | --- |
| `lib/qmp.js` | `qcap.py` 的 `qmp_dump` | 连一次就关；超时/错误归类成错误码；PPM 走 stdout 二进制流回本地 |
| `lib/burst.js` | `qcap.py` 的 burst/stop | 录制器带 `seconds` 自限、`meta.json`、每帧 5 次重试、帧先写 `tmp/` 再原子 rename；stop 有 TERM/KILL 阶梯 |
| `lib/frames.js` | `qcap.py` 的 fetch（tar+xz） | 改成单 ssh 流分帧协议 `F/T/M`，不再打 tar 包；本地逐帧转码并算 p50/p95；可边录边取 |
| `lib/guest.js` | `gagent.py` | 包装器输出走 base64 单行 `JEV1:<b64>:<exit>`，绕开 PVE 的码页解码（中文不再乱码） |
| `lib/bridge.js` | `bridge.py` | 同样的计划任务 + VBS 隐藏启动；每次调用只用 1 次 guest exec，按 vmid 串行；被吞的启动会重发 |
| `lib/actions.js` | `actions.py` | CLICK 保留 14 步 smoothstep，`clicks` 缺省为 1；TYPE/KEY 拆成两个工具；SHOT（CopyFromScreen）**未采用** |
| `lib/nodes.js` | 无（原脚本写死 `HOST=192.168.90.104`） | 新增：ssh 主机可传/可配可环境变量，VM→节点用 `qm status` 现查，多台 running 时报候选 |
| `pve_snapshot` | playbook §3 的 rollback 流程 | 多了 `confirm`、快照名校验、`agent_up_ms` 计量 |

---

## 8. 安全

- **ssh 参数全 argv 化**，脚本经 stdin 送远端 `bash -s`；VMID 只接受整数、快照名走正则、`tmpfsDir` 走严格路径正则——用户输入不会被拼进 shell 字符串。
- **`allowedVmids` 是可选限制**（默认不限制）：多人共用一台集群、只想让它碰某几台 VM 时填上。
- **`pve_guest_exec` 每次调用都写审计日志**（完整脚本 + 结果摘要 + 节点 + vmid），`allowGuestExec:false` 时工具不注册。
- **`pve_snapshot` 需要显式确认**，且回滚前的运行状态会在结果里说明。
- 回滚销毁当前状态是不可逆的：本插件不提供"回滚前自动快照"。

---

## 9. 排障顺序

1. `pve_vm_status` 返回 `NODE_NOT_CONFIGURED` → 传 `node` 或设 `PVE_HOSTS`。
2. 返回 `NODE_UNREACHABLE` → VPN/ssh，跟插件无关。
3. `status: stopped` → start 或 `pve_snapshot`。
4. `agent: down` 但 status running → 等 30–90 s；guest agent 冷启动慢。
5. `QMP_BUSY` 且没有 burst 在跑 → 有人开着 PVE Web 控制台，关掉它。
6. 截图全黑 → `wake:true`，或先 `pve_click` 一次再截。
7. 点击/输入不动 → `pve_vm_status` 看 `agent`，再确认控制台是 session 1 且已登录（`quser`）。
