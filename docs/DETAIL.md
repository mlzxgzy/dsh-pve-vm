# dsh-pve-vm

把 `prototype/pve/` 里跑通的 PVE 观测/控制脚本做成 DSH 工具：**集群资产管理、截图、连拍、取帧、点击、输入、按键、guest 内 PowerShell、回滚快照**，不用 bash 拼 ssh。

目标场景是"让 agent 看屏幕并操作一台 Windows 虚拟机"，因此每个设计都围绕三件事：返回值有界、失败可解释、动作可撤销。**包里没有写死任何集群地址、节点名、VMID、快照名**：连一次、读一次集群、现查一次。

---

## 1. 能力与边界

**做**：集群级资产盘点（节点、VM、存储的配额与占用，一次 ssh 取全量）、节点名 ↔ 管理地址解析、宿主 QMP 截图（不经 guest 桌面合成，可 `wake` 唤醒黑屏）、4 fps 级后台连拍（帧写节点 tmpfs，边录边取）、按区间取帧并给出真实帧间隔、session 1 内点击/输入/按键、guest agent 内执行 PowerShell、回滚到快照并等 agent 重新就绪。

**不做**：视觉模型、视频合成、UI 面板、多 VM 编排、Linux 目标、把帧直播到本地播放器、写集群（创建/迁移/销毁 VM 一律不做）。

---

## 2. 连接模型：集群是单位

PVE 的"连一台"其实是"连一个集群"。本插件按这个事实设计：

| 事实 | 后果 | 插件的做法 |
| --- | --- | --- |
| 节点名（`pve04`）在 DNS 里解析不了 | `ssh root@pve04` 报 `Could not resolve hostname` | 从 `/etc/pve/.members` 拿 **`nodename → ip`** 映射，用它当 ssh 目标 |
| `qm status <vmid>` 只认本节点 | 在 pve04 上查 pve07 的 VM 报 `Configuration file 'nodes/pve04/qemu-server/<vmid>.conf' does not exist` | 先查 VM 在哪个节点，再 ssh 到**属主节点**执行 |
| 一次 ssh 能拿到整个集群的清单 | 逐节点 `qm list` 要 7 次往返 | `pvesh get /cluster/resources` 一次拿 276 台 VM + 28 个存储 + 7 个节点，缓存 15 s |
| 集群可能不可用（standalone 节点、VPN 断） | 硬依赖集群会让单机也用不了 | `clusterMode`：`auto`（先试集群，失败回退逐主机）、`on`（必须集群）、`off`（只用逐主机 `qm list`） |

于是所有工具的启动参数是一个 **`node`：ssh 别名或地址**，它只负责"从哪台机器问"。VM 在哪台节点、该节点地址是什么，都由集群快照回答；`vmid` 也可以完全不传——集群里只有一台 running 时自动选它，多台就报 `AMBIGUOUS_VMID` 并列出候选，不猜。

集群快照的内容：集群名、quorate、投票数、config version、transport、每节点（online、管理 IP、cpu%、mem/disk 用量、VM 计数）、每台 VM（vmid、名字、状态、节点、vCPU、内存/磁盘）、每个存储（used/total、shared、content）。

---

## 3. 安装

```bash
plugin_manager install_bundle target=/abs/path/to/dsh-plugin/dsh-pve-vm
# 或在 Web GUI：Settings → Plugins → Add plugin → 选这个目录
```

随包的 `cordis.patch.yml` **只插入条目，不写任何 config**。装完什么事都不会发生，直到你知道该连哪台机器——三种等价方式，任选一种：

| 方式 | 例子 | 适用 |
| --- | --- | --- |
| 每次调用带 `node` | `pve_cluster_status {node:"pve04"}` | 临时用，什么都不用配 |
| 环境变量 | `PVE_HOSTS=pve04,192.168.90.101` | 常驻的机器/ssh 别名 |
| 插件设置 | Settings 卡片里填 `hosts: ["pve04"]` | 固定集群 |

`node` 接受 **ssh 别名或地址**。只要一台能连通，整个集群就可见（用它的 `/etc/pve/.members` 当入口）。

卸载：`plugin_manager action=remove_bundle target=dsh-pve-vm`。卸载时会尽力停掉远端录制循环。

---

## 4. 配置项（Settings 卡片 / profile patch 层）

全部可选，共 21 项。**默认值的安全含义写在"说明"列**，不是写在代码里的白名单。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `hosts` | `[]` | 入口 ssh 别名/地址（`PVE_HOSTS`/`PVE_HOST` 等价）。空也行——每次调用传 `node`。 |
| `clusterMode` | `auto` | `auto`：先用集群快照，不可用则退回逐主机 `qm list`；`on`：必须集群（`pve-cluster-*` 场景）；`off`：从不读集群。 |
| `clusterCacheMs` | `15000` | 集群快照缓存（0–600000）。取 reservation 之类的实时数字前传 `fresh:true`。 |
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

## 5. 工具

二十个工具，全部返回 JSON；失败返回 `{ok:false, code, message, hint, details?}`（不抛裸异常）。所有工具都接受 `node`（ssh 别名/地址）。

| 工具 | 主要参数 | 返回 |
| --- | --- | --- |
| `pve_cluster_status` | `node?`, `fresh?` | `cluster,quorate,standalone,expected_votes,votes,config_version,transport,source,seed,seed_node,hosts,node_count,online_count,vms_total,vms_running,storage_total,listed_nodes,nodes[],wall_ms` |
| `pve_cluster_assets` | `node?`(种子), `on?`(节点名), `type?`, `status?`, `name?`, `limit=40`, `sort=vmid`, `order=asc`, `fresh?` | `cluster,source,total,shown,truncated,sort,order,counts{by_type,by_status,by_node},items[],wall_ms` |
| `pve_vm_status` | `vmid?`, `node?`, `fresh?` | `vmid,host,node,status,agent,agent_ms,source,burst,frames,cluster,quorate,nodes_online,nodes_total,hosts,vms,picked,vm_total,vms_truncated,running_count,wall_ms` |
| `pve_snapshot` | `vmid?`, `node?`, `snapshot=init`, `confirm`（必填 true） | `snapshot,previous_status,rollback_ms,stop_ms,start_ms,agent_up_ms` |
| `pve_screenshot` | `vmid?`, `node?`, `name?`, `format?`, `quality?`, `inline?`, `wake?`, `wakeX?`, `wakeY?` | `path,bytes,w,h,format,encoder,blank,woke,ms,wall_ms[,data,encoding,inline_skipped]` |
| `pve_burst` | `vmid?`, `node?`, `action=start\|stop\|status`, `fps=4`, `seconds=20` | `action,dir,local,fps,frames,started_ms,pid,running,was_running,waited_ms,killed,deadline_ms,already` |
| `pve_fetch_frames` | `vmid?`, `node?`, `from?`, `to?`, `max=200`, `format?` | `count,dir,first_index,last_index,first_ms,last_ms,interval_p50_ms,interval_p95_ms,contiguous,missing,skipped,total_on_node,pattern,sample` |
| `pve_click` | `vmid?`, `node?`, `x`, `y`, `button`, `clicks` | `x,y,button,clicks,output,ms` |
| `pve_type` | `vmid?`, `node?`, `text`, `enter?`, `delayMs?` | `chars,enter,output,ms` |
| `pve_key` | `vmid?`, `node?`, `key`, `repeat?`, `delayMs?` | `expression,repeat,output,ms` |
| `pve_guest_exec` | `vmid?`, `node?`, `script`, `timeoutMs?` | `stdout,stderr,exit,truncated,bytes,audit,ms` |
| `pve_vm_power` | `vmid`, `node?`, `action=start\|stop\|shutdown\|reboot\|reset\|status`, `timeout=60`, `forceStop?`, `wait=true`, `waitTimeoutMs=180000` | `vmid,host,node,action,previous_status,status,changed,waited_ms,output,wall_ms` |
| `pve_sendkey` | `vmid`, `node?`, `key`, `repeat=1`, `delayMs=150` | `vmid,host,node,key,repeat,output,wall_ms` |
| `pve_vm_config` | `vmid`, `node?`, `current?`, `network=true`, `osinfo=true` | `status,name,cores,sockets,memory_mb,ostype,boot,agent,scsihw,bios,machine,onboot,disks,nets,interfaces,os,snapshots,config,raw,agent_error,wall_ms` |
| `pve_vm_snapshot` | `vmid`, `node?`, `action=list\|create\|delete\|rollback`, `name?`, `description?`, `vmstate?`, `force?`, `confirm?` | `vmid,host,node,action,name,snapshots,count,status,output,wall_ms` |
| `pve_task` | `node?`, `action=list\|status\|log`, `upid?`, `vmid?`, `type?`, `limit=20`, `wait?`, `timeoutMs=300000` | `host,node,action,upid,tasks,total,state,exitstatus,running,waited_ms,log,truncated,wall_ms` |
| `pve_storage_content` | `node?`, `storage?`, `content?`, `vmid?`, `name?`, `limit=40` | `storages[],items[],total,shown,truncated,wall_ms` |
| `pve_vm_migrate` | `vmid`, `node?`, `target`, `online=true`, `withLocalDisks?`, `targetstorage?`, `bwlimit?`, `wait=true`, `timeoutMs=600000` | `vmid,host,node,target,new_node,new_host,status,task,task_state,exitstatus,output,waited_ms,wall_ms` |
| `pve_vm_clone` | `vmid`, `newid`, `node?`, `name?`, `target?`, `storage?`, `full?`, `snapname?`, `pool?`, `bwlimit?`, `wait=true` | `source_vmid,newid,name,host,node,new_node,new_host,status,task,task_state,exitstatus,output,waited_ms,wall_ms` |
| `pve_vm_delete` | `vmid`, `node?`, `confirm`（必填 true）, `purge=true`, `destroyUnreferencedDisks?`, `stop?`, `wait=true` | `vmid,host,node,name,previous_status,task,task_state,exitstatus,output,waited_ms,wall_ms` |

几个刻意为之的行为：

- **先问集群，再问机器**：`pve_cluster_status` / `pve_cluster_assets` 一次 ssh 回答"这个集群有什么"，`pve_vm_status` 传 `vmid` 时把它解析到属主节点再操作。`pve_cluster_assets` 的 `node` 只当种子，**按节点名过滤要用 `on`**（首版把两者混成一个参数，`{node:"192.168.90.104",status:"running"}` 会返回 `0 of 0`）。
- **排序是服务端做的**：`pve_cluster_assets {sort:"mem", order:"desc"}` 先排序再截断，所以 `limit:5` 拿到的一定是最大的 5 个，不是"前 5 个里最大的"。`sort` 支持 `vmid/name/status/node/cpu/mem/disk/uptime`；cpu/mem/disk 对 VM 和节点用 used 值，对存储池用 used bytes。
- **列表一律有界**：`pve_vm_status` 最多列 25 台（running 优先）并给出 `… and N more VMs`；`pve_cluster_assets` 默认 40 条、`limit` 上限 200，`counts` 始终是全量统计；`pve_cluster_status` 最多 40 行节点。276 台的集群不会把上下文刷满。
- **`pve_screenshot` 只给路径和字节数**，不塞 base64。`inline:true` 且小于 200 KB 时才附图片，否则返回 `inline_skipped`。
- **`wake:true` 会把黑屏点醒**：截图后判 `blank`（全黑或纯色），若是黑屏就经 session-1 桥在 `(wakeX??1150, wakeY??620)` 点一次、等 900 ms 再截，结果里 `blank:true, woke:true`，可读输出也会写明这两句。默认关——它会在桌面上留下一次点击。
- **`pve_burst` 是后台循环**，帧写节点 `${tmpfsDir}/v<vmid>/burst/`，带 `times.csv`（每帧相对毫秒）和 `meta.json`。它有 `seconds` 上限（默认 20，天花板 `burstMaxSeconds`），即使调用方消失也会自己停。每帧先写 `tmp/` 再原子 rename，所以**录制中取帧拿到的一定是完整 PPM**。
- **`pve_fetch_frames` 支持区间**（`from`/`to`/`max`），3000 帧的录制可以分批取，每批都告诉你 `interval_p50_ms` 和是否 `contiguous`；录制没结束也能取。
- **`pve_snapshot` 要求 `confirm:true`**，并且结果里回显被回滚到的快照名——因为回滚会丢弃当前状态。
- **`pve_guest_exec` 的脚本按原样进滚动审计日志**（`audit.jsonl`），结果里带回日志路径。
- **电源/迁移/克隆/删除都会等结果**：`pve_vm_power` 的 `wait` 用本地轮询确认 VM 真的到了目标状态（`changed` 说明状态确实变了）；`pve_vm_migrate` / `pve_vm_clone` / `pve_vm_delete` 若 qm 回了 UPID 就轮询任务到 `stopped`，失败抛 `TASK_FAILED`、超时抛 `TASK_TIMEOUT`；迁移/克隆结束后重新查一次集群，回报**新属主节点**而不是"你让我去的节点"。
- **破坏性操作要显式确认**：`pve_vm_snapshot action:"rollback"` 和 `pve_vm_delete` 都要求 `confirm:true`，`pve_vm_delete` 还拒绝正在运行的 VM（除非 `stop:true`），结果里回显被销毁的 VM 名与状态。
- **`pve_sendkey` 走宿主层**：`qm sendkey` 不需要 guest agent、不需要会话 1，agent 挂了、控制台没登录也能按键——这是 `pve_key`（走 session-1 桥、能发组合键与 `{ENTER}`）失效时的兜底。
- **`pve_vm_config` 先读配置再看 guest**：`qm config` 一定有答案；`network`/`osinfo` 只是额外问 guest agent，agent 不回就只记 `agent_error`，不让整个调用失败。
- **`pve_task` 是异步操作的唯一真相**：clone/migrate/备份/恢复都会回 UPID，`action:"status"` 配 `wait:true` 阻塞到结束，`action:"log"` 读尾部日志；`exitstatus:"OK"` 才是成功。
- **失败带 `details`。** 严格输出 schema 下没有"随手多塞一个字段"的自由，所以诊断信息（帧数、回滚耗时、审计路径、候选 VM）统一放在 `details` 对象里，`hint` 里给出下一步。

---

## 6. 错误码

| 码 | 含义 | 常见修法 |
| --- | --- | --- |
| `NODE_NOT_CONFIGURED` | 既没有 `hosts`、`PVE_HOSTS`，调用也没带 `node` | 三者任选其一 |
| `NODE_UNREACHABLE` | ssh 连不上（VPN 断了最常见） | 检查 VPN；`ssh -o ConnectTimeout=5 root@<node> true` |
| `NOT_A_CLUSTER` | `clusterMode:"on"`，但节点上没有 `/etc/pve/.members` | 改 `auto`/`off`，或指向真正的集群节点 |
| `AMBIGUOUS_VMID` | 多台 VM 在 running，无法自动挑 | 传 `vmid`；候选在 `details.vms` |
| `VM_NOT_FOUND` | 集群/候选节点上都没有这台 VM | 看 `details.hosts` 的 `qm status` 回显 |
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
| `SNAPSHOT_NOT_FOUND` | 快照名不存在 | 先 `qm listsnapshot <vmid>` |
| `BURST_ACTIVE` / `BURST_NOT_RUNNING` | 已有一个连拍在跑 / 没有可停的 | 先 `action:stop` |
| `BURST_START_FAILED` | 远端录制器起不来 | 看 `message` 里的远端日志尾 |
| `FRAMES_MISSING` | 没有帧可取 | 先 start，再 fetch |
| `GUEST_EXEC_DISABLED` | `allowGuestExec` 被关掉 | 开配置 |
| `GUEST_EXEC_FAILED` | guest 侧仍在跑/失败 | 提高 `guestTimeoutMs` |
| `BRIDGE_FAILED` / `BRIDGE_TIMEOUT` | session-1 桥失败/超时 | 重试；确认 session 1 已登录 |
| `VM_POWER_FAILED` / `VM_POWER_TIMEOUT` | qm 拒绝电源操作 / 命令被接受但状态没变 | 看 `details.output`；锁或坏盘常见 |
| `TASK_FAILED` / `TASK_TIMEOUT` | 异步任务失败 / 超时仍在跑 | 读 `details.exitstatus`；再用 `pve_task action:"log"` |
| `STORAGE_UNKNOWN` | 该节点上没有这个存储 id | 不带 `storage` 先列池子 |
| `SNAPSHOT_EXISTS` | 快照名已存在 | 换名或先删 |
| `BAD_ARGS` | 参数越界（坐标、fps、脚本长度…） | 看 `message` |
| `CONVERT_FAILED` | PPM 解码或本地编码失败 | 检查本机 ffmpeg/convert |
| `INTERNAL` | 未预期异常 | 附 `message` |

---

## 7. 已知限制

1. **`QMP_BUSY`（连拍期间截图）是工具层策略，不是 QMP 的物理必然。** 录制器每帧连一次 QMP 就关，socket 在帧之间是空闲的——实测连拍进行中直接走 QMP 也能截到图。工具层先查 `burstStatus` 再短路，是为了让"连拍期间不要抢 socket"这件事**确定**，而不是赌 5 ms 的空窗。若真有人长期占着 socket（PVE Web 控制台），QMP 层超时同样给 `QMP_BUSY`。
2. **guest 执行在 session 0（SYSTEM），点击/输入在 session 1（Administrator）。** 两套通道不能混用：`pve_guest_exec` 里调 SendKeys 或桌面 API 什么也看不到；`pve_click`/`pve_type` 想跑无人值守脚本也不行（会话切换用不了）。这就是为什么 `pve_type`/`pve_key` 每次要 2–4 s——它们要经计划任务把脚本投进交互会话。
3. **`pve_snapshot` 会先停 VM**（`qm rollback` 在 running 状态不成立），所以 `agent_up_ms` 是"回滚 + 冷启动 + agent 就绪"的合计量，实测 40–90 s 量级，不是 30 s。等 agent 用 **exit code** 判定，不 grep 文本——本版 PVE 的 `qm agent ping` 成功时没有输出。
4. **集群快照是缓存过的**（`clusterCacheMs`，默认 15 s）。刚建的 VM 可能不在快照里，`fresh:true` 才会重读。写操作（迁移、创建、销毁）本插件不做。
5. **集群视图依赖 `pvesh` 与 `/etc/pve/.members` 可读**（即 ssh 用户能读 `pve-cluster` 目录，root 可以）。`clusterMode:"on"` 时读不到集群文件会直接报 `NOT_A_CLUSTER`（而不是悄悄降级）；`auto` 会安静退回逐主机 `qm list`。单机节点在 `auto` 下仍可用：快照里那台合成为 `ip: null` 的节点，地址回退成你连它用的那个 `node`。**standalone 只用夹具验证过**——本网络 7 台 PVE 全在同一个集群里，没有真单机可测；该分支、`NOT_A_CLUSTER` 与地址回退由 `dev/test-cluster.mjs` 用真实 `.members`/`pvesh` 输出做夹具验证（33 项断言）。
6. **节点名不能被解析**：`node` 参数写 `pve04` 时用的是用户自己的 ssh 配置；写地址（`192.168.90.104`）最稳。集群解析出的属主地址一律来自 `.members` 的 `ip`。
7. **QMP 帧不含鼠标指针。** 需要看指针位置时，用 guest 内查询（`[Cursor]::Position`，屏幕坐标）。
8. **连拍的帧在节点 tmpfs 上**，节点重启或换节点就没了；插件不做跨节点同步。
9. **JPEG 编码发生在本机**（ffmpeg → convert → magick 依次尝试），三者都没有时回退成纯 JS PNG（文件后缀会自动变成 `.png`）。节点上没有 PIL/ffmpeg，别指望在那里转码。
10. **一次点击不等于前进一页。** 注入事件会被 Windows 输入栈批量消费，实测一次点击能连过三页。动作后必须截图确认，不要用日志时间戳当"动作完成时间"。
11. **`pve_guest_exec` 的输出是真实输出，但可能被截断**（`maxGuestOutputBytes`，默认 8 KB）；`truncated:true` 时要分批取。单次往返实测 1.8–5.9 s（含 PowerShell 冷启动）。
12. **回滚/冷启动后的头几帧可能是全黑。** guest 里桌面和 explorer 都在（`quser` 显示 console 1 Active），但 Windows 还没往 VGA 扫描输出内容，QMP 截到的是纯黑帧（实测恰好 **12,203 B**，正常桌面 48–119 KB）。`wake:true` 会点一次把它点醒；否则自己 `pve_click` 一下再截。
13. **取帧会在本地多写两个文件**：`times.csv`（节点上的原始时间戳）和 `frames.json`（录制清单：序号、字节、缺失、抓取时间）。这样那批 JPEG 脱离节点也能直接再剪接。
14. **坐标是屏幕坐标，别按窗口相对算。** 1280×800 下任务栏"开始"按钮中心约 **(22,783)**；y=758/770 落在任务栏条上但点不开菜单（实测）。UIA 的 `BoundingRectangle` 同样是屏幕坐标。
15. **逐主机回退依赖 `qm list` 的文本格式。** 解析器只认 `VMID NAME STATUS MEM(MB) BOOTDISK(GB)` 这五列（`lib/nodes.js` 的 `QM_LIST_ROW`）；集群模式走 JSON，不受影响。
16. **ssh 链路的失败与"插件坏了"要分开看。** VPN 断掉的表现是约 8 s 后 `NODE_UNREACHABLE`（`ssh: connect to host … Connection timed out`），不是工具超时。

17. **`qm <cmd> --help` 在 PVE 7.4 上不存在**（`Unknown option: help` / `400 unable to parse option`）。选项名来自节点上的 `man qm`（`/usr/share/man/man1/qm.1.gz`）；换 PVE 大版本时先重读 man，别假设选项没变。
18. **迁移/克隆只对集群成员成立**：`qm migrate` 的目标必须是 `pvecm nodes` 里的节点名（工具会先校验并列出候选）；`qm clone` 的 `newid` 必须空闲，`--full` 会真的复制整块盘（32 GB 模板就是 32 GB 流量）。
19. **`pve_vm_delete` 不可撤销**，`--purge` 默认开（会从备份任务/HA/资源池里摘掉）。它拒绝 running 的 VM，除非显式 `stop:true`——这是故意让"顺手删掉正在跑的实验机"需要两次确认。
20. **`pve_vm_snapshot` 的 rollback 不等 guest**：它只保证快照回滚完成；回滚后要等 agent 可用，用 `pve_snapshot`（它会等 `agent_up_ms`）。
21. **`pve_sendkey` 的键名是 QEMU 名字**（`ret`/`esc`/`tab`/`ctrl-alt-delete`/`alt-f4`/`f12`），不是 SendKeys 表达式；组合键请用 `pve_key`。

---

## 8. 与参考实现的对应关系

| 本插件 | 参考 | 差异 |
| --- | --- | --- |
| `lib/qmp.js` | `prototype/pve/qcap.py` 的 `qmp_dump` | 连一次就关；超时/错误归类成错误码；PPM 走 stdout 二进制流回本地 |
| `lib/burst.js` | `qcap.py` 的 burst/stop | 录制器带 `seconds` 自限、`meta.json`、每帧 5 次重试、帧先写 `tmp/` 再原子 rename；stop 有 TERM/KILL 阶梯 |
| `lib/frames.js` | `qcap.py` 的 fetch（tar+xz） | 改成单 ssh 流分帧协议 `F/T/M`，不再打 tar 包；本地逐帧转码并算 p50/p95；可边录边取 |
| `lib/guest.js` | `prototype/pve/gagent.py` | 包装器输出走 base64 单行 `JEV1:<b64>:<exit>`，绕开 PVE 的码页解码（中文不再乱码） |
| `lib/bridge.js` | `prototype/pve/bridge.py` | 同样的计划任务 + VBS 隐藏启动；每次调用只用 1 次 guest exec，按 vmid 串行；被吞的启动会重发 |
| `lib/actions.js` | `prototype/pve/actions.py` | CLICK 保留 14 步 smoothstep，`clicks` 缺省为 1；TYPE/KEY 拆成两个工具；SHOT（CopyFromScreen）**未采用** |
| `lib/nodes.js` | 无（原脚本写死 `HOST=192.168.90.104`） | ssh 主机可传/可配可环境变量，VM→节点用 `qm status` 现查，多台 running 时报候选 |
| `lib/cluster.js` | 无（路线图里的 `plan/01-cluster-inventory.md`） | 一次 ssh 读 `.members` + `pvecm` + `pvesh /cluster/resources`；集群缓存、`auto/on/off` 三档；节点名→地址解析 |
| `pve_snapshot` | playbook §3 的 rollback 流程 | 多了 `confirm`、快照名校验、`agent_up_ms` 计量 |

---

## 9. 安全

- **ssh 参数全 argv 化**，脚本经 stdin 送远端 `bash -s`；VMID 只接受整数、快照名走正则、`tmpfsDir` 走严格路径正则——用户输入不会被拼进 shell 字符串。
- **`allowedVmids` 是可选限制**（默认不限制）：多人共用一台集群、只想让它碰某几台 VM 时填上。
- **`pve_guest_exec` 每次调用都写审计日志**（完整脚本 + 结果摘要 + 节点 + vmid），`allowGuestExec:false` 时工具不注册。
- **`pve_snapshot` 需要显式确认**，且回滚前的运行状态会在结果里说明。
- 回滚销毁当前状态是不可逆的：本插件不提供"回滚前自动快照"。
- 集群视图是**只读**的：只调用 `pvesh get` / `pvecm status` / `qm status` / `qm list`，不碰任何写接口。

---

## 10. 排障顺序

1. `NODE_NOT_CONFIGURED` → 传 `node` 或设 `PVE_HOSTS`。
2. `NODE_UNREACHABLE` → VPN/ssh，跟插件无关。
3. 想确认"我看到的是整个集群"→ `pve_cluster_status`，看 `quorate`、`online_count`、`source`（`cluster` 还是 `hosts`）。
4. `status: stopped` → start 或 `pve_snapshot`。
5. `agent: down` 但 status running → 等 30–90 s；guest agent 冷启动慢。
6. `QMP_BUSY` 且没有 burst 在跑 → 有人开着 PVE Web 控制台，关掉它。
7. 截图全黑 → `wake:true`，或先 `pve_click` 一次再截。
8. 点击/输入不动 → `pve_vm_status` 看 `agent`，再确认控制台是 session 1 且已登录（`quser`）。
9. VM 明明在、插件说 `VM_NOT_FOUND` → `pve_cluster_status` 看 `source`；若退回 `hosts` 且只连了一台节点，属主节点的 `/etc/pve` 可能没读到。
