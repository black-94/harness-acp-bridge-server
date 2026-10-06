# SOP：远程 Docker 隔离工作副本，通过 ACP 委派 CodeBuddy 检查和测试

> 根据本次完整操作整理。命令区分「本地协调端」「远程宿主机」「容器」「ACP 工具调用」。
> 本次最终结果：隔离、认证、swap 和 DNS 修复成功；单路构建生成 175/176 个核心对象，但 Clang 18.1.3 内部崩溃，**测试未运行，不能判定通过**。
> 该 SOP 是操作记录与复用指南，不代表其中所有故障恢复/重启演练都已执行。
> 配套脚本是本次成功逻辑的整理版，已做语法/文档检查；本次没有用这份整理版重新部署远程环境或重新运行编译测试。

## 1. 目标、边界与参数

### 1.1 本次实际参数

| 项目 | 参数/路径 |
|---|---|
| SSH | `root@100.73.183.32` |
| 只读源仓库 | 宿主机 `/root/git/sail-all` → 容器 `/git` |
| 随机任务目录 | 宿主机 `/root/tasks/sail-all-hdqiodfe` → 容器 `/workspace` |
| 工作副本 | `/workspace/sail-all` |
| 被检查项目 | `/workspace/sail-all/sail-core` |
| Docker 镜像 | `agent-base:latest` |
| 容器名称 | `sail-all-hdqiodfe` |
| 容器完整 ID | `2154e02f929ddded3575b011cdc354513b680848c38d121b8a590d2f3e954f03` |
| 网络 | Docker `--network host` |
| 生命周期 | `--restart unless-stopped`，不用 `--rm`；ACP `container_policy=keep` |
| 容器用户 | 镜像默认 `root`；未创建新用户 |
| 权限收缩 | `--cap-drop ALL --security-opt no-new-privileges:true` |
| ACP harness | `codebuddy` |
| ACP 工作目录 | **`/workspace`**，不是宿主机路径，也不是项目子目录 |
| ACP 权限 | `permission_mode=yolo`；CodeBuddy 实际映射为 `bypassPermissions` |
| ACP 模型 | 用户确认的 `deepseek-v4.1-flash` |
| 推理等级 | `thinking_level=high` |
| 宿主资源 | 2 CPU，约 1.7 GiB RAM |
| 最终内存配置 | 2 GiB `/swapfile`，`vm.swappiness=10` |
| 最终编译参数 | `--full --release --jobs 1`，不加 `--clean` |

镜像标签可变化。本次镜像 ID 为 `sha256:ba5c60cd634b2ea2eaea066ee332898a1a0d9e92ef2f4912736ff81722a48298`；需要严格复现时核对/固定实际镜像 ID，不只依赖 `latest`。

### 1.2 隔离保证与不保证的事项

- `/git` 只读；副本文件、索引、refs、新提交对象写入自己的 `/workspace/sail-all/**/.git`。
- 不挂载宿主 SSH 凭据、SSH agent socket 或 Docker socket，不使用 `--privileged`。
- 移除副本 remotes，设置 `push.default=nothing`，安装拒绝推送的 `pre-push` 钩子。
- **硬边界是只读挂载；Git 钩子可被删除或用 `--no-verify` 绕过，不能当作安全沙箱。**
- 用户最终确认的“无法上传”范围是禁止推回源仓库。`host` 网络仍可联网，**不能保证代码无法向任意网络地址外传**；如果容器获得其他服务的有效写入凭据，也不能用本地只读挂载阻止该网络写入。
- 如要求彻底防外传，必须另行设计出站白名单/网络隔离，不能沿用“host 网络即可防外传”的假设。
- shared 副本依赖源 objects；不要删除源仓库或执行可能清掉副本所需对象的源端 prune/GC。副本的 `gc.auto=0` 不会替源仓库提供对象保留保证。

### 1.3 两种使用方式

- **复用当前环境**：不要重新创建 swap、克隆目录或安装已存在的 unit；从第 6 节的 ACP 连接/第 7 节的委派继续。
- **在同类新环境重建**：按下面的推荐顺序执行；支持脚本在 [`scripts/`](scripts/) 与 [`systemd/`](systemd/) 中。

本地 shell 示例默认使用 Bash。`SOP` 为本目录的绝对路径：

```bash
# 本地协调端
export REMOTE=root@100.73.183.32
export SOP=/Users/gituser/godot/sail-all/docs/docker-acp-sop
export BRIDGE_DIR=/Users/black94/project/harness-acp-bridge-server
export BRIDGE_CONFIG=/Users/black94/.config/harness-acp-bridge/config.yaml
```

以下需要 root 的网络/swap 修改必须在用户授权后执行。复制到其他机器前修改地址、网卡和路径，不要套用本机硬编码规则。

## 2. 预检：先确认资源与网络，再跑重型任务

```bash
# 本地协调端
ssh -o BatchMode=yes -o ConnectTimeout=15 "$REMOTE" '
  hostname; id; date -Is
  docker version --format "{{.Server.Version}}"
  docker image inspect agent-base:latest \
    --format "ID={{.Id}} User={{json .Config.User}} WorkingDir={{json .Config.WorkingDir}} Entrypoint={{json .Config.Entrypoint}} Cmd={{json .Config.Cmd}}"
  stat -c "%A %U:%G %n" /root/git/sail-all /root/tasks
  git -C /root/git/sail-all status --short
  git -C /root/git/sail-all submodule status --recursive
  nproc; free -h; swapon --show; df -h /
  timeout 10s getent ahostsv4 wb.tencentbuddy.com
'
```

要求：

1. SSH 非交互认证可用；不在聊天/文档中传密码或 token。
2. 镜像已存在，确认默认用户与工具安装位置。
3. 源主仓库和已初始化的递归子模块可读取。源有未提交改动时先澄清，不能把 clone 后的 HEAD 副本误当作包含所有工作区改动。
4. 内存足够。对于本机 1.7 GiB RAM，先启用 swap 并采用单路构建。
5. DNS 与模型 HTTPS 可达。否则 ACP 可能只返回空的 `refusal`，实际是网络错误。

**本次实际顺序与推荐顺序不同**：最初先启动了无 swap 的双路构建，发生内存/磁盘抖动和失联；重启后才补 swap 和 DNS 修复。复用 SOP 时应前置这些预检。

## 3. 启动持久容器与随机 workspace

### 3.1 创建容器（远程宿主机）

```bash
# 在远程宿主机 shell 中执行
set -eu
SOURCE=/root/git/sail-all
IMAGE=agent-base:latest
WORKSPACE=$(mktemp -d /root/tasks/sail-all-XXXXXXXX)
CONTAINER=$(basename "$WORKSPACE")

docker run --detach \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --init \
  --network host \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --mount "type=bind,source=$SOURCE,target=/git,readonly" \
  --mount "type=bind,source=$WORKSPACE,target=/workspace" \
  --workdir /workspace/sail-all \
  --entrypoint /bin/sh \
  "$IMAGE" -c 'exec sleep infinity'

docker inspect "$CONTAINER" --format '{{.Id}}'
printf 'CONTAINER=%s\nWORKSPACE=%s\n' "$CONTAINER" "$WORKSPACE"
```

参数要点：

| 参数 | 作用/注意事项 |
|---|---|
| `--detach` | 后台运行 |
| `--restart unless-stopped` | 重启 Docker/服务器后通常自动恢复；手工停止后不保证自动启动 |
| `--init` | 使用 init 回收子进程 |
| `--network host` | 共享宿主网络，不需要发布端口；不提供出站隔离 |
| `--mount ...readonly` | 源仓库不可写，包含 `.git` 与子模块 objects |
| 第二个 `--mount` | 工作区写入随机宿主目录，可持续保留 |
| `--cap-drop ALL` | 不授予额外 Linux capabilities |
| `no-new-privileges:true` | 禁止通过 setuid 等方式增加权限 |
| `--workdir /workspace/sail-all` | 容器默认 shell 项目目录；**ACP 可另外指定 `/workspace`** |
| `sleep infinity` | 保持容器运行，不等于自动启动 agent |
| 不使用 `--rm` | 容器退出也不自动删除 |

本次**没有额外设置 Docker CPU/内存限额**。这是实际配置，不是建议在所有机器上照搬；增设限额需另行测量 agent+编译器工作集，过低的硬限额会导致容器 OOM。

### 3.2 在本地记录当前容器参数

```bash
# 复用本次环境；重建时替换成上一步的真实输出
export CONTAINER=sail-all-hdqiodfe
export WORKSPACE=/root/tasks/sail-all-hdqiodfe
export DOCKER_ID=2154e02f929ddded3575b011cdc354513b680848c38d121b8a590d2f3e954f03

ssh "$REMOTE" "docker inspect '$CONTAINER' \
  --format 'Running={{.State.Running}} Network={{.HostConfig.NetworkMode}} Restart={{.HostConfig.RestartPolicy.Name}} AutoRemove={{.HostConfig.AutoRemove}} Mounts={{json .Mounts}}'"
```

验收：`/git` 的 `RW=false`、`/workspace` 的 `RW=true`，网络 `host`、重启策略 `unless-stopped`、`AutoRemove=false`。

进入项目 shell：

```bash
ssh -t "$REMOTE" "docker exec -it -w /workspace/sail-all '$CONTAINER' bash"
```

## 4. shared 工作副本：包括浅克隆和递归子模块

### 4.1 基本命令

```bash
# 容器内，仅对全新/空工作区执行
# 与用户原始要求一致：git clone --shared /path/to/source /path/to/target
git clone --shared /git /workspace/sail-all
```

主仓库 clone **不会自动填充所有子模块代码**。不要直接跑使用远端 URL 的 `git submodule update --init --recursive` 取代本机副本方案。

### 4.2 成功的完整处理流程

```bash
# 本地协调端：标准主仓库 clone 后，补齐全部递归子模块并配置本地提交/拒绝push
ssh "$REMOTE" "docker exec -i '$CONTAINER' python3 -" \
  < "$SOP/scripts/clone-shared-workspace.py"
```

该脚本：

1. 用 `git submodule foreach --recursive` 获取源中已初始化的全部子模块。
2. 从源的 `git-common-dir` 本地 clone，检出与源一致的 HEAD。
3. 所有仓库都借用 `/git/.../objects`；设置独立 user.name/email，移除 remotes，拒绝 push。
4. 仅在副本 `.git/config` 中把子模块 URL 指向 `/git/...`，**不修改 tracked `.gitmodules`**。
5. 输出 `/workspace/clone-manifest.json`、`container-info.json`。

本次为 **1 个主仓库 + 13 个递归子模块 = 14 个仓库**。

### 4.3 浅克隆陷阱：`--shared` 会被忽略

本次部分源子模块是 shallow；直接 `clone --shared` 后缺少 alternates。换成源 `.git`/common-dir 或加 `--local` **仍不能解决浅仓库限制**。

成功修复不是补全历史，而是：

```text
副本 .git/objects/info/alternates = 对应 /git/.../objects
副本 .git/shallow                = 复制源的 shallow 边界（如存在）
```

以 `sail-core` 为例，alternate 为：

```text
/git/.git/modules/sail-core/objects
```

配套脚本先把 clone 生成的对象目录改名为备份，建立借用对象目录，复制 shallow 边界，执行：

```bash
git -C /workspace/sail-all/sail-core fsck --connectivity-only
git -C /workspace/sail-all/sail-core status --porcelain
```

仅在验证通过后删除**本次工作副本的对象备份**；失败恢复对象备份，停止后续步骤。不是删除源 objects，也不是删除整个工程。

检查历史边界：

```bash
# 容器内
git -C /git rev-parse --is-shallow-repository
git -C /workspace/sail-all rev-parse --is-shallow-repository
git -C /workspace/sail-all rev-list --count HEAD
git -C /workspace/sail-all submodule foreach --recursive --quiet \
  'printf "%s shallow=" "$displaypath"; git rev-parse --is-shallow-repository'
```

本次主仓库非 shallow，HEAD 可达 7 个提交；13 个子模块中 10 个 shallow、3 个非 shallow，副本与源一致。**没有执行 `fetch --unshallow`，没有从远端下载完整历史。**

### 4.4 隔离验收（只在新建、干净副本上执行）

```bash
# 本地协调端；不得在已有用户修改/提交的工作区上重跑初始化验收
ssh "$REMOTE" "docker exec -i '$CONTAINER' python3 -" \
  < "$SOP/scripts/verify-workspace.py"
```

验收脚本对每个仓库检查：

- 源 `.git/config` 以只写、**不截断/不写内容**方式打开应返回 `EROFS`；
- alternate 位于 `/git`；remotes 为空；
- 在副本创建临时分支和文件，实际本地提交，新对象位于副本 objects；
- push 到 `/git` 被副本 hook 拒绝；
- 源 HEAD、refs、status、config hash 不变；
- 恢复副本原 HEAD/分支与干净状态，删除临时分支；
- `fsck --connectivity-only --no-dangling` 与递归子模块指针正常。

输出 `/workspace/verification.json`。本次 14 个仓库全部通过。临时测试提交可能留在副本 reflog/对象存储中，但没有保留分支或源码变化。

## 5. 小内存机器的 swap 与单路策略

### 5.1 实际设置

先确认文件系统、磁盘空间和现有 swap：

```bash
# 远程宿主机
free -h
swapon --show --bytes
df -h /
findmnt -no FSTYPE /
sysctl vm.swappiness
```

本机为 ext4，无现有 swap，根盘剩余约 19 GiB。**已经配置好的当前机器不要重跑创建脚本**：

```bash
# 本地协调端；只用于无 /swapfile、无同名 sysctl 配置的新环境
ssh "$REMOTE" 'python3 -' < "$SOP/scripts/configure-swap.py"
```

实际核心命令为：

```bash
# 远程宿主机；下面是原理展开，不要在脚本之后重复执行
fallocate -l 2147483648 /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
sysctl -w vm.swappiness=10
```

脚本先独占创建文件，拒绝覆盖现有文件，检查至少 4 GiB 磁盘余量，并备份 `/etc/fstab` 后追加：

```fstab
/swapfile none swap sw 0 0
```

新文件 `/etc/sysctl.d/99-sail-build-swap.conf`：

```ini
vm.swappiness = 10
```

原机器 `/etc/sysctl.d/99-apsara-sysctl.conf` 为 `swappiness=0`，新文件名称排序更后。其他机器仍需检查是否存在后续 sysctl/tuned 覆盖。

本次 fstab 备份：`/etc/fstab.sail-swap-backup-20261005T161039Z`。

验证：

```bash
swapon --show --bytes
free -h
sysctl vm.swappiness
```

如果创建中途失败，先检查文件、签名、活动 swap 与 fstab，再决定补完/回滚；**不要盲目再次 mkswap 或删除活动 swap 文件**。

### 5.2 构建策略

```bash
# 容器内，由受委派 CodeBuddy 实际执行
cd /workspace/sail-all/sail-core
timeout --signal=TERM --kill-after=30s 1200s \
  python3 build/build_test.py --full --release --jobs 1
```

| 参数 | 意义 |
|---|---|
| `--full` | 选择全部现有测试套件 |
| `--release` | 本项目采用 `-O2` |
| `--jobs 1` | 单路编译，不改脚本默认值 |
| 不加 `--clean` | 保留已生成对象/PCH/ccache，后续可增量继续 |
| `1200s` | 每轮 20 分钟执行上限 |
| `--signal=TERM` | 超时先发送 TERM |
| `--kill-after=30s` | TERM 无效时再给 30 秒后 KILL |

`124` 表示执行超时；`137` 可能是 KILL fallback/其他 SIGKILL，需要结合日志；不能把这些退出码当成功。

swap 的主要价值是腾出匿名内存、保持系统可用，不等于物理内存，也不保证编译提速。持续 swap-in/out 与高 iowait 仍需减负/升级 RAM。本次无法单独量化“swap”和“从 2 路降为 1 路”的各自贡献。

## 6. CodeBuddy 启动、模型、认证与 ACP 参数

### 6.1 查询 harness 能力与启动路径

ACP 工具调用（不是 shell 命令）：

```json
{"tool":"acp_harness_info","arguments":{"harness":"codebuddy"}}
```

本次可配置 `yolo` 与 `high`，用户选择 `deepseek-v4.1-flash`。模型必须确认，不默默替换；支持列表随账号/版本变化。

本次 bridge 配置文件：

```text
/Users/black94/.config/harness-acp-bridge/config.yaml
```

其中启动 command 为 `/usr/local/bin/codebuddy`，而镜像实际文件为 `/opt/node/bin/codebuddy`，导致：

```text
OCI runtime exec failed ... /usr/local/bin/codebuddy: no such file or directory
```

这不是 ACP 协议强制路径，而是本次 bridge 配置。`acp_create_session` 没有单次 command 覆盖参数。本次经用户授权增加兼容软链接：

```bash
# 本地协调端
ssh "$REMOTE" "docker exec '$CONTAINER' sh -c '
  set -eu
  test -x /opt/node/bin/codebuddy
  if test -e /usr/local/bin/codebuddy || test -L /usr/local/bin/codebuddy; then
    test \"\$(readlink /usr/local/bin/codebuddy)\" = /opt/node/bin/codebuddy
  else
    ln -s /opt/node/bin/codebuddy /usr/local/bin/codebuddy
  fi
  /usr/local/bin/codebuddy --version
'"
```

本次显示 `2.155.0`。保留当前容器时链接仍在；重建容器需重新预检。不要覆盖另一个真实可执行文件。

### 6.2 创建/复用 Docker ACP 会话

```json
{
  "tool": "acp_create_session",
  "arguments": {
    "cwd": "/workspace",
    "model_id": "deepseek-v4.1-flash",
    "thinking_level": "high",
    "harness": "codebuddy",
    "permission_mode": "yolo",
    "target": "remote",
    "remote_host": "root@100.73.183.32",
    "runtime": "docker",
    "docker_id": "2154e02f929ddded3575b011cdc354513b680848c38d121b8a590d2f3e954f03",
    "container_policy": "keep"
  }
}
```

关键点：

- `docker_id` 使用**完整 64 位 ID**，复用现有挂载和 host 网络。
- 复用容器时不要再混入 `docker_image`、`mounts`、`ports`、`host_network` 等新容器参数。
- `cwd` 是容器路径。
- `yolo` 是 agent 工具权限，不等于 `--privileged`，不会解除 `/git` 的只读挂载。
- `container_policy=keep` 表示保留容器，**不保证关闭/失败清理后仍在运行**。本次失败连接后容器曾被停止，必须核验再恢复：

```bash
ssh "$REMOTE" "docker inspect '$CONTAINER' --format '{{.State.Running}}'"
# 仅确认停止后恢复原容器；不是重建
ssh "$REMOTE" "docker start '$CONTAINER'"
```

本次最终使用的 bridge session：`2026-10-06-42522bb4`；其创建 UTC 是 2026-10-05，ID 的日期与 UTC 可因本地时区不同，不用 session 名推断故障时间。

### 6.3 登录方式

```json
{"tool":"acp_auth_info","arguments":{"session_id":"<SESSION>"}}
```

本次 CodeBuddy 返回：

| method_id | 登录方式 |
|---|---|
| `iOA` | Login with iOA |
| `external` | Login with Google/Github |
| `internal` | **Login with WeChat** |
| `selfhosted` | 企业域名 |

用户更正为微信后，应使用 `internal`，不是 `iOA`。

```json
{"tool":"acp_authenticate","arguments":{"session_id":"<SESSION>","method_id":"internal"}}
```

### 6.4 浏览器链接没有展示：后台认证 + 原始通知提取

本次 `authenticate` 同步等待浏览器授权，工具没有展示 `_codebuddy.ai/authUrl` 异步通知；两次调用被中止并返回 `AbortError`，微信请求一度没有实际发送。

**重置只是清理旧流程，不保证修复链接展示。**本次成功方法是新会话中，通过同一 bridge daemon 的 IPC 后台发起认证，再读取授权通知。没有直接绕过 harness 权限或认证协调器。

配套 [`scripts/bridge-call.mjs`](scripts/bridge-call.mjs) 将本次 Node IPC 调用整理成可复用 CLI；它要求已运行的 bridge daemon，不是系统自带的 `harness-acp-bridge` 命令。

```bash
# 本地协调端；SESSION 必须取本次 create_session 的真实返回值
export SESSION='<SESSION>'
export AUTH_LOG="/tmp/codebuddy-$SESSION-auth.log"

nohup node "$SOP/scripts/bridge-call.mjs" authenticate \
  "{\"session_id\":\"$SESSION\",\"method_id\":\"internal\"}" \
  > "$AUTH_LOG" 2>&1 < /dev/null &
echo "AUTH_PID=$!"
```

从当前会话日志提取**最新有效**链接，及时交给用户打开：

```bash
# 本地协调端；授权链接由 CodeBuddy 生成，不要自己拼 state
python3 - "$HOME/.harness-acp-bridge/$SESSION/raw.jsonl" <<'PY'
import json, sys
urls = []
for line in open(sys.argv[1]):
    event = json.loads(line)
    value = event.get('value', {})
    if value.get('method') == '_codebuddy.ai/authUrl':
        urls.append(value.get('params', {}).get('authUrl'))
if not urls:
    raise SystemExit('尚未收到 authUrl；检查后台请求/会话状态，不伪造链接')
print(urls[-1])
PY
```

用户完成浏览器微信登录后：

```bash
node "$SOP/scripts/bridge-call.mjs" auth_info \
  "{\"session_id\":\"$SESSION\"}"
```

必须得到 `authenticated=true`、`state=ready` 才委派任务。不要把“页面打开”“认证进程等待”当作登录完成，也不要把 token/password 写入报告。

重置旧会话用 `acp_close_session`，然后核验并恢复原 Docker 容器，再 `acp_create_session`；**不要销毁重建容器**。

### 6.5 设置模型与推理等级

```json
{
  "tool": "acp_set_model",
  "arguments": {
    "session_id": "<SESSION>",
    "model_id": "deepseek-v4.1-flash",
    "thinking_level": "high"
  }
}
```

本次恢复旧 harness 会话时遇到未支持的 `_codebuddy.ai/artifact` 通知，错误为 `unrecognized ACP JSON-RPC message`。处理：复用原容器、创建**新的 ACP 会话且不传 `resume_session_id`**；任务提示中要求不调用 `TaskCreate/TaskUpdate`，不重建工作副本。此限制针对本次 bridge 版本，不是 ACP 所有实现的通用限制。

## 7. 委派、监控与任务验收

### 7.1 建立独立报告目录和宿主机采集

在每轮任务前，在**远程宿主机**执行，避免跨轮覆盖：

```bash
# 远程宿主机；本次曾用 run2/run3，复用时换新名称
REPORT=/root/tasks/sail-all-hdqiodfe/reports/sail-core-swap-j1-NEW-RUN
test ! -e "$REPORT"
mkdir -p "$REPORT"
{ date -Is; free -b; swapon --show --bytes; sysctl vm.swappiness; } \
  > "$REPORT/host-before.txt"

nohup timeout 1500s vmstat -w -t 10 \
  > "$REPORT/host-vmstat.log" 2>&1 < /dev/null &
echo "vmstat=$!" >> "$REPORT/monitor-pids.txt"
nohup timeout 1500s pidstat -h -r -u -d -p ALL 10 \
  > "$REPORT/host-pidstat.log" 2>&1 < /dev/null &
echo "pidstat=$!" >> "$REPORT/monitor-pids.txt"
nohup timeout 1500s iostat -xz -t 10 \
  > "$REPORT/host-iostat.log" 2>&1 < /dev/null &
echo "iostat=$!" >> "$REPORT/monitor-pids.txt"
```

- 采样间隔 10 秒，25 分钟自动结束；避免无限监控进程。
- `vmstat`：`swpd`、`si/so`、`r/b`、`wa`；`r` 不是 load average，不能混为同一指标。
- `pidstat`：按 PID/进程名比较 RSS 与 CPU/磁盘。CodeBuddy 可能名为 `MainThread`，不只匹配 `node`。
- `iostat`：`avg-cpu %iowait`、`vda %util`、`r_await/w_await`；首个 since-boot 样本应从本轮统计中排除。
- 可让 child 另采 `/proc/<pid>/status` 中的 `VmRSS/VmSwap`，不读取凭据或 `/proc/*/environ`。
- 分析限定实际构建起止窗口，不把任务前后空闲数据混入均值；采样峰值不是连续监测的绝对峰值。

### 7.2 委派提示模板

保存为本地 `/tmp/sail-core-prompt.txt`，把报告目录换成当前轮：

```text
在 /workspace/sail-all/sail-core 实际运行编译与全部现有测试。
ACP cwd=/workspace，模型 deepseek-v4.1-flash/high，权限 yolo。
读取适用AGENTS.md和测试说明，记录主仓库及所有子模块起始HEAD/status。
不得修改tracked源码、测试、构建脚本、Git配置；不得commit/push/upload、
fetch/unshallow、修改网络/swap或停止容器。不要创建TaskCreate/TaskUpdate。

实际命令：
timeout --signal=TERM --kill-after=30s 1200s \
  python3 build/build_test.py --full --release --jobs 1
不要加--clean，不跳过/禁用测试。后台运行必须最终等待并收集真实退出码。

每轮新报告目录 /workspace/reports/<NEW-RUN>/，不要覆盖旧报告或host日志。
保存build-test.log、command-and-result.txt（命令/cwd/UTC起止/耗时/退出码）、
exit-code.txt、git-before/after.txt、summary.md以及必要的资源采样。
报告每个套件与实际用例计数、通过/失败/未运行原因、资源变化和残留进程。
超时或失败立即如实报告，不修源码、清缓存或无限重试。
最后复核HEAD/status，列出新增untracked，不git clean，容器保持运行。
```

如果委派的是代码审查而不是单纯资源实验，另加：按严重度列出有证据的问题，提供精确文件/行号、触发条件、影响；不得把猜测或风格意见当成缺陷。

### 7.3 提交任务：队列、幂等与异步

```json
{
  "tool": "acp_send_message",
  "arguments": {
    "session_id": "<SESSION>",
    "text": "<上述完整任务提示>",
    "mode": "queue",
    "idempotency_key": "sail-core-<NEW-RUN>"
  }
}
```

- `queue` 避免意外 steering 打断当前任务。
- 同一去重键仅用于**完全相同**的 prompt/mode 重试；不同轮、不同提示换新键。
- 本环境 `acp_send_message` 工具会同步等待；需要立刻拿到 `message_id` 时用相同 daemon IPC：

```bash
# 本地协调端；prompt_file 是本配套CLI转换成 text 的选项，不是 ACP 原生字段
node "$SOP/scripts/bridge-call.mjs" send_message \
  "{\"session_id\":\"$SESSION\",\"prompt_file\":\"/tmp/sail-core-prompt.txt\",\"mode\":\"queue\",\"idempotency_key\":\"sail-core-<NEW-RUN>\"}"
```

返回的 `message_id` 才是查询对象，不要用 shell task ID 替代。

### 7.4 等待并判断真实结果

```json
{"tool":"acp_wait","arguments":{"session_id":"<SESSION>","message_id":"<MESSAGE>"}}
```

或者通过 IPC 查询（无人交互时建议约 10 分钟一次，不做紧密忙轮询）：

```bash
node "$SOP/scripts/bridge-call.mjs" message_result \
  "{\"session_id\":\"$SESSION\",\"message_id\":\"$MESSAGE\"}"
node "$SOP/scripts/bridge-call.mjs" live_output \
  "{\"session_id\":\"$SESSION\",\"message_id\":\"$MESSAGE\",\"offset\":0,\"max_bytes\":65536}"
```

后续预览使用返回的 `next_offset`，不反复从 0 读取。

**三层状态必须分开：**

1. ACP `state=completed`：agent turn 结束，不表示命令成功。
2. shell/构建脚本退出码：`0` 才表示该命令正常结束；还须检查执行范围。
3. 测试结果：每个要求的套件实际运行并有可信通过/失败/跳过数。

特别注意：本次 `completed + stop_reason=refusal + text=""` 的原始 `_meta.codebuddy.ai/errorMessage` 是 `getaddrinfo EAI_AGAIN wb.tencentbuddy.com`，即模型请求失败，**没有执行任何工具/编译**。

原始记录目录（不要公开整个文件，可能包含任务内容与认证通知）：

```text
~/.harness-acp-bridge/<SESSION>/log.txt
~/.harness-acp-bridge/<SESSION>/raw.jsonl
~/.harness-acp-bridge/<SESSION>/preview.txt
```

协调端验收时只读核对：原始命令/退出码/构建测试日志、必要资源样本、Git diff/status、Docker 运行状态。worker 的“完成”报告只是输入，不能自动视为验收通过。

## 8. 故障 SOP：失联、DNS 与精确持久化修复

### 8.1 ACP 30 分钟超时或 SSH 不可达

本次旧消息在 1800000 ms 后 `output_timeout`，随后 ACP transport gone、SSH 两次超时。不要直接宣布模型卡死、测试通过或容器被销毁。

先只读检查：

```bash
# 本地协调端
ssh -o BatchMode=yes -o ConnectTimeout=15 -o ConnectionAttempts=1 "$REMOTE" '
  date -Is; uptime; free -h; swapon --show; df -h /
  journalctl --list-boots --no-pager
  docker inspect sail-all-hdqiodfe --format "{{json .State}}"
'
```

服务器由用户重启后，用前一启动日志与历史指标定位，不反复重跑重型任务：

```bash
# 远程宿主机；换成真实故障时间/日志日期
journalctl -b -1 -k --no-pager -o short-iso
journalctl -b -1 --since '2026-10-05 15:07:00 UTC' \
  --until '2026-10-05 15:53:00 UTC' --no-pager -o short-iso \
  --case-sensitive=no -g 'out of memory|oom-kill|killed process|hung task|panic'
journalctl -b -1 -u tailscaled -u ssh -u docker --no-pager -o short-iso

LC_ALL=C sar -r ALL -f /var/log/sysstat/sa05 -s 15:00:00 -e 15:52:00
LC_ALL=C sar -B     -f /var/log/sysstat/sa05 -s 15:00:00 -e 15:52:00
LC_ALL=C sar -u ALL -f /var/log/sysstat/sa05 -s 15:00:00 -e 15:52:00
LC_ALL=C sar -q ALL -f /var/log/sysstat/sa05 -s 15:00:00 -e 15:52:00
LC_ALL=C sar -d -p  -f /var/log/sysstat/sa05 -s 15:00:00 -e 15:52:00
```

本次证据：持续 `Under memory pressure`、可用内存约 170 MiB、iowait 90–92%、磁盘利用率约 97%、load 约 20。**没有 OOM kill 记录**，支持内存压力与文件页回收/重读盘造成 I/O thrashing，而不是“确定 OOM 杀死 SSH”。没有旧逐进程历史，不应捏造编译器/agent 的精确旧峰值。

### 8.2 DNS 失败层级分析

```bash
# 远程宿主机
resolvectl status --no-pager
resolvectl statistics
ip -4 rule show
ip -4 route get 100.100.2.136
ip -4 route get 100.100.2.138
iptables-save -c

dig @127.0.0.53 wb.tencentbuddy.com A +time=2 +tries=1
dig @100.100.2.136 wb.tencentbuddy.com A +time=2 +tries=1
dig @100.100.2.138 wb.tencentbuddy.com A +time=2 +tries=1
dig @223.5.5.5 wb.tencentbuddy.com A +time=2 +tries=1
dig @1.1.1.1 wb.tencentbuddy.com A +time=2 +tries=1
dig +tcp @100.100.2.136 wb.tencentbuddy.com A +time=2 +tries=1
iptables -nvxL ts-input --line-numbers
```

本次默认链路：主机/host 网络容器 → `127.0.0.53` → DHCP 分配的 `100.100.2.136/138`。两个云 DNS 都落在 `100.64.0.0/10`，路由经 `eth0`。

Tailscale 规则：

```text
-A ts-input -s 100.64.0.0/10 ! -i tailscale0 -j DROP
```

抓包验证时，用固定查询源端口缩小范围：

```bash
# 远程宿主机：一个终端抓包，另一个终端执行dig
tcpdump -nn -vv -i eth0 \
  'udp and host 100.100.2.136 and port 53053 and port 53'
dig -b 172.29.115.153#53053 @100.100.2.136 \
  wb.tencentbuddy.com A +time=2 +tries=1
```

实际抓到匹配事务 ID 的正确回复约 51 ms 到达，但 `dig` 超时，`ts-input` DROP 计数增加；公共 DNS 查询成功。根因为 Tailscale 的 CGNAT 反欺骗规则丢弃云 DNS 回复，不是域名不存在、Docker 独有问题或当前内存耗尽。

### 8.3 本次选择：保留云 DNS，只放行精确已建立回复

必须限制：

```text
入接口：eth0
源地址：100.100.2.136/32、100.100.2.138/32
协议：UDP、TCP
源端口：53（不是目的端口）
conntrack：ESTABLISHED（不放行 NEW）
```

实际逻辑规则（由配套脚本幂等安装，不建议另外手工再插一套）：

```bash
iptables -I INPUT 1 -m comment --comment sail-cloud-dns-replies -j SAIL_CLOUD_DNS
# 专用链内的四条 ACCEPT：
for ip in 100.100.2.136 100.100.2.138; do
  for protocol in udp tcp; do
    iptables -A SAIL_CLOUD_DNS -i eth0 -s "$ip/32" \
      -p "$protocol" -m "$protocol" --sport 53 \
      -m conntrack --ctstate ESTABLISHED \
      -m comment --comment sail-cloud-dns-replies -j ACCEPT
  done
done
iptables -A SAIL_CLOUD_DNS -j RETURN
```

非匹配流量返回后继续经过 `ts-input`/UFW，不放行整个 `100.64.0.0/10` 或 `100.100.0.0/16`。本机有旧 `/usr/local/sbin/tailscale-allow-aliyun-internal.sh`（整段 /16 放行），但其 `10-allow-aliyun-internal.conf` 是空的禁用配置；**没有启用这个旧脚本**。

### 8.4 部署持久化（只用于尚未安装的新环境）

下列安装路径已在当前服务器存在，复用当前环境时直接验证，不覆盖。

```bash
# 本地协调端
STAGE=$(ssh "$REMOTE" 'mktemp -d /root/sail-cloud-dns-deploy.XXXXXXXX')
scp "$SOP/scripts/sail-cloud-dns-replies.py" "$SOP/systemd/"* "$REMOTE:$STAGE/"
ssh "$REMOTE" "STAGE='$STAGE' bash -s" <<'SH'
set -eu
for target in /usr/local/sbin/sail-cloud-dns-replies.py \
  /etc/systemd/system/sail-cloud-dns.service \
  /etc/systemd/system/sail-cloud-dns.timer \
  /etc/systemd/system/tailscaled.service.d/90-sail-cloud-dns.conf; do
  test ! -e "$target" && test ! -L "$target" || exit 1
done
iptables-save -c > "$STAGE/iptables-before.v4"
install -d /etc/systemd/system/tailscaled.service.d
install -m 0755 "$STAGE/sail-cloud-dns-replies.py" /usr/local/sbin/sail-cloud-dns-replies.py
install -m 0644 "$STAGE/sail-cloud-dns.service" /etc/systemd/system/sail-cloud-dns.service
install -m 0644 "$STAGE/sail-cloud-dns.timer" /etc/systemd/system/sail-cloud-dns.timer
install -m 0644 "$STAGE/90-sail-cloud-dns.conf" /etc/systemd/system/tailscaled.service.d/90-sail-cloud-dns.conf
systemd-analyze verify /etc/systemd/system/sail-cloud-dns.service /etc/systemd/system/sail-cloud-dns.timer
systemctl daemon-reload
systemctl enable sail-cloud-dns.service sail-cloud-dns.timer
systemctl start sail-cloud-dns.service
systemctl start sail-cloud-dns.timer
/usr/local/sbin/sail-cloud-dns-replies.py --check
SH
```

机制：

- `sail-cloud-dns.service`：开机执行，排序在 UFW/Tailscale 之后。
- `tailscaled.service.d/90-sail-cloud-dns.conf`：追加 `ExecStartPost=/usr/local/sbin/sail-cloud-dns-replies.py`，Tailscale 服务重启后恢复。
- `sail-cloud-dns.timer`：`OnBootSec=30s`、`OnUnitInactiveSec=30s`、`AccuracySec=5s`，定期幂等检查，防止其他防火墙更新改变跳转顺序。
- 脚本使用锁和 `iptables -w 5`，只维护自己的链/精确跳转，不 flush 整个规则集；遇到专用链的未知/重复规则停止而不是擅自覆盖。
- `daemon-reload` 不等于重启 Tailscale；本次**没有重启 SSH、Tailscale 或服务器来演练持久化**。
- 定时恢复不是连续瞬时保证，防火墙重写到下一次检查间仍可能有短暂解析失败。

验收命令：

```bash
# 远程宿主机
/usr/local/sbin/sail-cloud-dns-replies.py --check
/usr/local/sbin/sail-cloud-dns-replies.py
/usr/local/sbin/sail-cloud-dns-replies.py   # 重复执行不新增规则
iptables -S INPUT
iptables -nvxL SAIL_CLOUD_DNS --line-numbers
systemctl is-enabled sail-cloud-dns.service sail-cloud-dns.timer
systemctl is-active sail-cloud-dns.timer
systemctl show tailscaled -p ExecStartPost
systemctl list-timers sail-cloud-dns.timer --no-pager

for server in 100.100.2.136 100.100.2.138; do
  dig @"$server" wb.tencentbuddy.com A +time=2 +tries=1 +short
  dig +tcp @"$server" wb.tencentbuddy.com A +time=2 +tries=1 +short
done
getent ahostsv4 wb.tencentbuddy.com
docker exec sail-all-hdqiodfe getent ahostsv4 wb.tencentbuddy.com
docker exec sail-all-hdqiodfe curl --connect-timeout 5 --max-time 12 \
  -sS -o /dev/null -w 'remote_ip=%{remote_ip} http_status=%{http_code}\n' \
  https://wb.tencentbuddy.com
```

本次验证两台云 DNS UDP/TCP、主机与容器默认解析均成功，HTTPS 返回 200，SSH/Tailscale active、容器 running。审计快照：`/root/sail-cloud-dns-deploy.h62V4SXN/iptables-before.v4`。

## 9. 本次完整时间线、结论与交付

### 9.1 从初始部署到最终结论

| 阶段 | 实际结果/教训 |
|---|---|
| 启动隔离容器 | host 网络、随机 workspace、源只读，容器保持存续 |
| shared 克隆 | 普通 clone 不填子模块；浅源忽略 --shared，补 alternates+shallow+fsck |
| 隔离测试 | 14 仓库可读源/不可写源、副本可改可提交、拒绝push、源未变 |
| ACP 启动 | 配置路径和镜像路径不同，经授权增加软链接 |
| ACP 微信登录 | 同步认证未展示链接，重置不充分；后台IPC+读取authUrl后成功 |
| 初始代码检查/双路构建 | 无swap、jobs=2；只生成4对象，资源抖动，ACP30分钟超时，SSH失联 |
| 用户重启后排查 | 1.7GiB、无swap、持续内存压力和90%+iowait；没有OOM kill证据 |
| 内存调整 | 2GiB持久swap、swappiness10、jobs1 |
| ACP重试 | 模型DNS EAI_AGAIN，空refusal不表示执行任务 |
| DNS分析/修复 | 云DNS回复被TailscaleCGNAT规则丢弃；精确放行并持久恢复，验证HTTPS200 |
| run2实际单路构建 | 20分钟超时124；至少处理140/176、已有142对象，尚未进入测试 |
| run3缓存继续 | 318秒退出1；175/176对象，Clang前端SIGSEGV，测试仍未运行 |

### 9.2 run2/run3 真实数据

| 指标 | 最初故障 | run2（单路+swap） | run3（缓存继续） |
|---|---|---|---|
| 编译并行 | 2 | 1 | 1 |
| swap | 无 | 峰值约232MiB | 峰值约179MiB |
| iowait | 持续约90–92% | 通常0–4%，有单点约23% | 很低，报告均值约0.26% |
| 磁盘util | 约97% | 明显下降，无持续饱和 | 报告峰值约6% |
| 可达性 | 失联 | 调整后未再次观察到失联 | SSH/容器核验正常 |
| 命令退出 | 未取得 | 124，20分钟超时 | 1，核心编译失败 |
| 测试执行 | 无结果 | 全部未运行 | 全部未运行 |

资源采样确认单路 `clang++` RSS 观测峰值约 **771 MiB**，CodeBuddy RSS 约 **300 MiB**，其 VmSwap 曾约 **187 MiB**。这些是调整后观测，不能倒推旧故障每个进程的准确峰值。

### 9.3 最终阻塞：Clang 内部崩溃

run3 关键错误：

```text
Failed to compile .../obj/tools/game_state_data_validator.o
clang frontend command failed with exit code 139
Ubuntu clang version 18.1.3
source: tools/game_state_data_validator.cpp:208:35
stack: clang::Sema::tryCaptureVariable / BuildCXXForRangeStmt / constraint checks
```

- 不是普通源码诊断；是 Clang 前端 SIGSEGV/内部崩溃的证据。
- 构建脚本返回 1；该对象缺失，核心库未归档，测试未进入。
- 没有本轮 OOM kill 日志，资源指标也不支持此前那种持续资源饱和；但**不要仅用崩溃后 free 输出就声称绝对排除了所有资源/硬件因素**。
- 8 个套件 `melee/artillery/landing/sailing/codec/data/system/service` 都未运行，不能把“0失败”写成“通过”。
- 本次未改源码、未换编译器、未改变该文件编译参数。
- 后续应另行授权：先用更新版 Clang/隔离 PCH 等方法验证该翻译单元，再决定如何完成测试；不能把“更换版本必然修复”当已验证事实。

崩溃复现材料位于容器：

```text
/tmp/game_state_data_validator-5f4814.cpp
/tmp/game_state_data_validator-5f4814.sh
```

这些材料含项目代码，未经授权不要上传到公共 issue。

### 9.4 本次报告与复用入口

远程宿主机报告目录：

```text
/root/tasks/sail-all-hdqiodfe/reports/sail-core-review-20261005/
/root/tasks/sail-all-hdqiodfe/reports/sail-core-swap-j1-20261005-run2/
/root/tasks/sail-all-hdqiodfe/reports/sail-core-swap-j1-20261005-run3/
```

容器对应 `/workspace/reports/.../`。主要文件：`summary.md`、`build-test.log`、`command-and-result.txt`、`exit-code.txt`、`resource-samples.log`、`git-before/after.txt`、`host-*.log`。

本次 ACP 单路会话：`2026-10-06-42522bb4`；run2 消息 `msg-ee77f4b5876c`，run3 消息 `msg-633eca3c65f0`。未来重连需查询真实 ready/auth 状态，不把这些历史 ID 当永远有效。

## 10. 最终验收清单

- [ ] 源仓库/objects 只读，副本所有仓库 objects/refs/索引独立可写。
- [ ] 所有递归子模块已复制，HEAD与源初始化时一致，浅历史边界保留。
- [ ] 无宿主凭据、Docker socket 或 privileged 挂载；明示host网络不防任意外传。
- [ ] 容器 running、不使用--rm，失败/关闭ACP后也核验容器运行状态。
- [ ] 模型、high、yolo、remote host、docker_id、cwd已明确确认。
- [ ] authenticated=true/state=ready，授权链接按需展示，没有凭据泄露。
- [ ] DNS/default/cloud解析与模型HTTPS成功。
- [ ] swap/单路参数与实际资源采样有证据，监控有界。
- [ ] 任务真实执行，后台命令最终有退出码和原始日志。
- [ ] 全部要求测试实际运行，有可信计数；未运行/超时/编译失败不标通过。
- [ ] tracked源码与源仓库不变；容器保持运行；报告保存到宿主workspace。
- [ ] 失败由协调端核验并明确记录阻塞；需要修复时另行授权/委派。

**本次最后一项“全部测试通过”未满足，不能把此 SOP 的环境部署成功等同于测试任务成功。**

## 11. 收尾、恢复和受控回滚

### 11.1 任务结束不销毁容器

- 保存 session/message ID、报告目录、退出码和最终 Git 状态。
- 若要关闭 ACP 会话，先确认没有正在执行的构建；关闭后再次检查容器。
- `container_policy=keep` 只保证保留。若关闭/失败清理使容器停止，执行 `docker start` 恢复同一个容器；不要 `docker rm`、不要删随机 workspace。

```bash
# 本地协调端，关闭应先得到用户/任务生命周期许可
node "$SOP/scripts/bridge-call.mjs" close_session \
  "{\"session_id\":\"$SESSION\"}"
ssh "$REMOTE" "docker inspect '$CONTAINER' --format 'Running={{.State.Running}}'"
# 仅当停止时执行
ssh "$REMOTE" "docker start '$CONTAINER'"
```

### 11.2 DNS 例外回滚（未在本次执行）

**删除这些规则会重新暴露原云 DNS/Tailscale 冲突**。只有在确认不再需要例外、存在可用替代 DNS/带外访问、且已获授权时才执行。先核对专用链确实仍由本 SOP 独占；不要恢复整个旧 `iptables-save` 快照去覆盖后来新增的 Docker/Tailscale/UFW 规则。

```bash
# 远程宿主机，受控回滚示意：仅删除本SOP的精确跳转/专用链/新文件
systemctl disable --now sail-cloud-dns.timer
systemctl disable sail-cloud-dns.service
systemctl stop sail-cloud-dns.service
rm /etc/systemd/system/tailscaled.service.d/90-sail-cloud-dns.conf
systemctl daemon-reload

while iptables -w 5 -C INPUT -m comment --comment sail-cloud-dns-replies -j SAIL_CLOUD_DNS 2>/dev/null; do
  iptables -w 5 -D INPUT -m comment --comment sail-cloud-dns-replies -j SAIL_CLOUD_DNS
done
iptables -w 5 -F SAIL_CLOUD_DNS
iptables -w 5 -X SAIL_CLOUD_DNS
rm /etc/systemd/system/sail-cloud-dns.service \
   /etc/systemd/system/sail-cloud-dns.timer \
   /usr/local/sbin/sail-cloud-dns-replies.py
systemctl daemon-reload
```

这里 `-F` 只用于专用链，不是整个防火墙。若发现外部规则引用该链或出现意外规则，停止回滚并人工核对，不能强行 flush。

### 11.3 swap 回滚注意事项（未在本次执行）

- 先结束重型工作，确认物理可用内存足够容纳已换出的页；必要时另设维护窗口。
- 获批后才 `swapoff /swapfile`，检查退出码与 `swapon --show`，成功后才移除文件。
- 精确删除自己追加的 fstab 项与 sysctl 文件，并恢复已记录的原 swappiness；不要整份覆盖 fstab 备份而丢失后续管理员修改。
- 不能一边编译一边盲目关 swap，尤其在这台 1.7 GiB 机器上。

