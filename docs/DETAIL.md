# pve-vm-recorder

把 `prototype/pve/` 里跑通的 PVE 观测/控制脚本做成 DSH 工具：**截图、连拍、取帧、点击、输入、按键、guest 内 PowerShell、回滚快照**，不用 bash 拼 ssh。

目标场景是"让 agent 看屏幕并操作一个 Windows 虚拟机"，因此每个设计都围绕三件事：返回值有界、失败可解释、动作可撤销。

---

## 1. 能力与边界

**做**：宿主 QMP 截图（不经 guest 桌面合成）、4 fps 级后台连拍（帧写节点 tmpfs）、按区间取帧并给出真实帧间隔、session 1 内点击/输入/按键、guest agent 内执行 PowerShell、回滚到快照并等 agent 重新就绪。

**不做**：视觉模型、视频合成、UI 面板、多 VM 编排、Linux 目标、远程传输帧到本地后再播放。

---

## 2. 安装

```bash
# 两种等价方式
plugin_manager install_bundle target=/abs/path/to/dsh-plugin/pve-vm-recorder
# 或在 Web GUI：Settings → Plugins → Add plugin → 选这个目录
```

随包的 `cordis.patch.yml` 会插入条目 `pve-vm-recorder`，并写入参考部署的 config（单节点 `192.168.90.104`、`allowedVmids [15047]`、`allowGuestExec true`）。**schema 的默认值全部是安全侧**：`nodes []`、`allowedVmids []`、`allowGuestExec false` —— 也就是说裸插入一个不做配置的条目，任何工具都不会碰任何虚拟机。

卸载：`plugin_manager action=remove_bundle target=pve-vm-recorder`。卸载时会尽力停掉远端录制循环。

---

## 3. 配置项（Settings 卡片 / profile patch 层）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `nodes` | `[]` | 允许 ssh 的节点名/IP，白名单。用于**探测** VM 在哪个节点（`qm status` 现查），不是写死节点。 |
| `sshUser` | `root` | ssh 用户。 |
| `sshPort` | `22` | ssh 端口。 |
| `sshKeyPath` | `''` | 私钥路径，空则用默认密钥。 |
| `sshConfigFile` | `/dev/null` | `ssh -F` 值。默认绕开系统 ssh_config —— PVE 环境的 ssh_config 权限常常是坏的。 |
| `sshExtraOptions` | `[]` | 追加的 `-o` 选项。 |
| `connectTimeoutMs` | `8000` | ssh ConnectTimeout。 |
| `defaultVmid` | `0` | 工具不传 `vmid` 时用它；`0` 表示必须显式传。 |
| `allowedVmids` | `[]` | **VMID 白名单，空 = 全禁**。任何工具都先过这一关。 |
| `tmpfsDir` | `/dev/shm/pve-rec` | 节点上的帧目录根。必须在 tmpfs（`/dev/shm`）上，写盘会拖垮连拍。 |
| `localOutDir` | `pve-rec` | 本地落盘目录（截图/取帧）。相对值按**会话工作目录**解析。 |
| `allowGuestExec` | `false` | 关掉时 `pve_guest_exec` **不出现在工具列表里**（不是调用被拒）。 |
| `guestTimeoutMs` | `120000` | guest 执行默认超时。 |
| `qmpTimeoutMs` | `3000` | QMP 连接/首帧超时；超时归类为 `QMP_BUSY`。 |
| `burstMaxSeconds` | `60` | 连拍时长上限，防止忘记停。 |
| `maxGuestOutputBytes` | `8192` | guest 输出截断阈值。 |
| `frameFormat` | `jpeg` | 取帧/截图格式，`jpeg` 或 `png`。 |
| `frameQuality` | `4` | JPEG 质量（ffmpeg `-q:v`，2–10）。 |
| `auditLog` | `''` | 审计日志路径，空则 `<localOutDir>/audit.jsonl`；超过 1 MiB 滚动为 `.1`。 |

---

## 4. 工具

九个工具，全部返回 JSON；失败返回 `{ok:false, code, message, hint}`（不抛裸异常）。

| 工具 | 主要参数 | 返回 |
| --- | --- | --- |
| `pve_vm_status` | `vmid?`, `fresh?` | `vmid,node,status,agent,agent_ms,burst,frames,allowed_vmids,nodes,configured,wall_ms` |
| `pve_snapshot` | `vmid?`, `snapshot=init`, `confirm`（必填 true） | `snapshot,previous_status,rollback_ms,stop_ms,start_ms,agent_up_ms` |
| `pve_screenshot` | `vmid?`, `name?`, `format?`, `quality?`, `inline?` | `path,bytes,w,h,format,encoder,ms,wall_ms[,data,encoding,inline_skipped]` |
| `pve_burst` | `vmid?`, `action=start\|stop\|status`, `fps=4`, `seconds=20` | `action,dir,local,fps,frames,started_ms,pid,running,was_running,waited_ms,killed,deadline_ms,already` |
| `pve_fetch_frames` | `vmid?`, `from?`, `to?`, `max=200`, `format?` | `count,dir,first_index,last_index,first_ms,last_ms,interval_p50_ms,interval_p95_ms,contiguous,missing,skipped,total_on_node,pattern,sample` |
| `pve_click` | `vmid?`, `x`, `y`, `button`, `clicks` | `x,y,button,clicks,output,ms` |
| `pve_type` | `vmid?`, `text`, `enter?`, `delayMs?` | `chars,enter,output,ms` |
| `pve_key` | `vmid?`, `key`, `repeat?`, `delayMs?` | `expression,repeat,output,ms` |
| `pve_guest_exec` | `vmid?`, `script`, `timeoutMs?` | `stdout,stderr,exit,truncated,bytes,audit,ms` |

几个刻意为之的行为：

- **`pve_screenshot` 只给路径和字节数**，不塞 base64。`inline:true` 且小于 200 KB 时才附图片，否则返回 `inline_skipped`。
- **`pve_burst` 是后台循环**，帧写节点 `${tmpfsDir}/v<vmid>/burst/`，带 `times.csv`（每帧相对毫秒）和 `meta.json`。它有 `seconds` 上限（默认 20，天花板 `burstMaxSeconds`），即使调用方消失也会自己停。
- **`pve_fetch_frames` 支持区间**（`from`/`to`/`max`），3000 帧的录制可以分批取，每批都告诉你 `interval_p50_ms` 和是否 `contiguous`。
- **`pve_snapshot` 要求 `confirm:true`**，并且结果里回显被回滚到的快照名——因为回滚会丢弃当前状态。
- **`pve_guest_exec` 的脚本按原样进滚动审计日志**（`audit.jsonl`），结果里带回日志路径。
- **失败带 `details`。** 严格输出 schema 下没有"随手多塞一个字段"的自由，所以诊断信息（帧数、回滚耗时、审计路径）统一放在 `details` 对象里，`hint` 里给出下一步。

---

## 5. 错误码

| 码 | 含义 | 常见修法 |
| --- | --- | --- |
| `NODE_NOT_ALLOWED` | 节点不在 `nodes` 白名单 | 加配置，别改代码 |
| `VMID_NOT_ALLOWED` / `BAD_VMID` | VMID 不在 `allowedVmids`，或不是正整数 | 加白名单 |
| `NODE_UNREACHABLE` | ssh 连不上（VPN 断了最常见） | 检查 VPN；`ssh -F /dev/null root@<node> true` |
| `SSH_TIMEOUT` | ssh 命令超时 | 提高 `timeoutMs`；断网时不是插件 bug |
| `SSH_FAILED` | 远端命令非零退出 | 看 `message` 里的远端 stderr |
| `QMP_BUSY` | QMP socket 被占用，或连不上（3 s 超时） | 等 burst 结束；关掉 PVE Web 控制台 |
| `QMP_MISSING` | `/var/run/qemu-server/<vmid>.qmp` 不存在 | VM 没跑，或不在这个节点 |
| `QMP_ERROR` | QMP 返回错误 | 看 `message` |
| `VM_STOPPED` | VM 不 running | `pve_snapshot` 或手动 start |
| `AGENT_DOWN` / `AGENT_TIMEOUT` | guest agent 不回 | 等 30–90 s；刚回滚完尤其慢 |
| `SNAPSHOT_CONFIRM_REQUIRED` | 没给 `confirm:true` | 显式确认 |
| `SNAPSHOT_NOT_FOUND` | 快照名不存在 | 先看 `pve_vm_status`/`qm listsnapshot` |
| `BURST_ACTIVE` / `BURST_NOT_RUNNING` | 已有一个连拍在跑 / 没有可停的 | 先 `action:stop` |
| `BURST_START_FAILED` | 远端录制器起不来 | 看 `message` 里的远端日志尾 |
| `FRAMES_MISSING` | 没有帧可取 | 先 start，再 fetch |
| `GUEST_EXEC_DISABLED` | `allowGuestExec` 未开 | 开配置 |
| `GUEST_EXEC_FAILED` | guest 侧仍在跑/失败 | 提高 `guestTimeoutMs` |
| `BRIDGE_FAILED` / `BRIDGE_TIMEOUT` | session-1 桥失败/超时 | 重试；确认 session 1 已登录 |
| `CONVERT_FAILED` | PPM 解码或本地编码失败 | 检查本机 ffmpeg/convert |
| `DISPLAY_DOWN` | 截到的是空画面 | 见"已知限制" |
| `INTERNAL` | 未预期异常 | 附 `message` |

---

## 6. 已知限制

1. **`QMP_BUSY`（连拍期间截图）是工具层策略，不是 QMP 的物理必然。** 录制器每帧连一次 QMP 就关，socket 在帧之间是空闲的——实测连拍进行中直接走 QMP 也能截到图。工具层先查 `burstStatus` 再短路，是为了让"连拍期间不要抢 socket"这件事**确定**，而不是赌 5 ms 的空窗。若真有人长期占着 socket（PVE Web 控制台），QMP 层超时同样给 `QMP_BUSY`。
2. **guest 执行在 session 0（SYSTEM），点击/输入在 session 1（Administrator）。** 两套通道不能混用：`pve_guest_exec` 里调 SendKeys 或桌面 API 什么也看不到；`pve_click`/`pve_type` 想跑无人值守脚本也不行（会话切换用不了）。这就是为什么 `pve_type`/`pve_key` 每次要 2–4 s——它们要经计划任务把脚本投进交互会话。
3. **`pve_snapshot` 会先停 VM**（`qm rollback` 在 running 状态不成立），所以 `agent_up_ms` 是"回滚 + 冷启动 + agent 就绪"的合计量，实测 60–90 s 量级，不是 30 s。等 agent 用 **exit code** 判定，不 grep 文本——本版 PVE 的 `qm agent ping` 成功时没有输出。
4. **QMP 帧不含鼠标指针。** 需要看指针位置时，用 guest 内查询（`[Cursor]::Position`，屏幕坐标）。
5. **连拍的帧在节点 tmpfs 上**，节点重启或换节点就没了；插件不做跨节点同步。
6. **JPEG 编码发生在本机**（ffmpeg → convert → magick 依次尝试），三者都没有时回退成纯 JS PNG（文件后缀会自动变成 `.png`）。节点上没有 PIL/ffmpeg，别指望在那里转码。
7. **一次点击不等于前进一页。** 注入事件会被 Windows 输入栈批量消费，实测一次点击能连过三页。动作后必须截图确认，不要用日志时间戳当"动作完成时间"。
8. **`pve_guest_exec` 的输出是真实输出，但可能被截断**（`maxGuestOutputBytes`，默认 8 KB）；`truncated:true` 时要分批取。单次往返实测 1.8–5.9 s（含 PowerShell 冷启动）。
9. **回滚/冷启动后的头几帧可能是全黑。** guest 里桌面和 explorer 都在（`quser` 显示 console 1 Active），但 Windows 侧还没往 VGA 扫描输出内容，QMP 截到的是纯黑帧（实测 12,203 B），一次真实的 session-1 输入后立刻正常（同尺寸 113,064 B）。所以 `pve_snapshot` 之后要截"看得见的桌面"，先 `pve_click` 一下再截，或者接受第一张是黑的。
10. **取帧会在本地多写两个文件**：`times.csv`（节点上的原始时间戳）和 `frames.json`（录制清单：序号、字节、缺失、抓取时间）。这样那批 JPEG 脱离节点也能直接再剪接。
11. **坐标是屏幕坐标，别按窗口相对算。** 1280×800 下任务栏"开始"按钮中心约 **(22,783)**；y=758/770 落在任务栏条上但点不开菜单（实测）。UIA 的 `BoundingRectangle` 同样是屏幕坐标。

---

## 7. 与参考实现的对应关系

| 本插件 | prototype/pve | 差异 |
| --- | --- | --- |
| `lib/qmp.js` | `qcap.py` 的 `qmp_dump` | 连一次就关；超时/错误归类成错误码；PPM 走 stdout 二进制流回本地 |
| `lib/burst.js` | `qcap.py` 的 burst/stop | 录制器带 `seconds` 自限、`meta.json`、每帧 5 次重试；stop 有 TERM/KILL 阶梯 |
| `lib/frames.js` | `qcap.py` 的 fetch（tar+xz） | 改成单 ssh 流分帧协议 `F/T/M`，不再打 tar 包；本地逐帧转码并算 p50/p95 |
| `lib/guest.js` | `gagent.py` | 包装器输出走 base64 单行 `JEV1:<b64>:<exit>`，绕开 PVE 的码页解码（中文不再乱码） |
| `lib/bridge.js` | `bridge.py` | 同样的计划任务 + VBS 隐藏启动；每次调用只用 1 次 guest exec，按 vmid 串行 |
| `lib/actions.js` | `actions.py` | CLICK 保留 14 步 smoothstep；TYPE/KEY 拆成两个工具；SHOT（CopyFromScreen）**未采用** |
| `pve_snapshot` | playbook §3 的 rollback 流程 | 多了 `confirm`、快照名校验、`agent_up_ms` 计量 |

---

## 8. 安全

- **VMID 白名单默认空**：没有 `allowedVmids` 时任何工具都拒绝执行。
- **ssh 参数全 argv 化**，脚本经 stdin 送远端 `bash -s`；VMID 只接受整数，节点只接受白名单项，`tmpfsDir` 走严格路径正则——用户输入不会被拼进 shell 字符串。
- **`pve_guest_exec` 双保险**：配置关着时工具根本不注册，配置开着时每次调用仍写审计日志。
- **`pve_snapshot` 需要显式确认**，且回滚前的运行状态会在结果里说明。
- 回滚销毁当前状态是不可逆的：本插件不提供"回滚前自动快照"。

---

## 9. 排障顺序

1. `pve_vm_status` 返回 `NODE_UNREACHABLE` → VPN/ssh，跟插件无关。
2. `status: stopped` → start 或 `pve_snapshot`。
3. `agent: down` 但 status running → 等 30–90 s；guest agent 冷启动慢。
4. `QMP_BUSY` 且没有 burst 在跑 → 有人开着 PVE Web 控制台，关掉它。
5. 截图全黑 → 控制台没挂接时 DWM 停止合成；确认 VM 有活动控制台会话（本插件截图走宿主 QMP，正常情况下不会有这个问题）。
