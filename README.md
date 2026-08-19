# IT 资产管理系统

一个单公司内部 IT 资产管理系统，包含 Web 管理端、SQLite 数据库和 Windows/macOS 采集 Agent。支持资产自动上报、手工资产、四类角色权限、完整生命周期申请与审批、全局审计、附件、工单、通知、保修提醒、采购成本与账面价值、盘点快照与差异闭环、二维码、CSV 报表、VNC 链接和 AD/MDM/SNMP/云资产集成配置框架。

## 资产录入方式

- 电脑由 Agent 自动上报硬件、系统和软件信息，管理端可补充部门、责任人、位置和资产标签。
- 服务器、交换机、防火墙、路由器、无线 AP、打印机、存储及其他资产在管理端手工录入。
- 管理端可维护资产生命周期状态，并在详情页查看最近变更记录。
- 管理端支持管理员、资产管理员、审计员和普通员工四类角色；普通员工只能查看本人资产并提交相关请求。
- 采购、入库、领用、归还、借用、维修、调拨、报废、回收、停用和启用均通过生命周期申请留下审批与审计记录。
- 资产和工单支持受保护附件；工单支持负责人、优先级、状态、评论和通知。
- 盘点场次会冻结资产快照，扫码使用场次 token，位置差异、漏盘和意外资产需要处理后才能结案。
- AD、MDM、SNMP、AWS、Azure、GCP 和 Webhook 以适配器配置与同步记录形式管理；未提供外部环境和凭据前不会伪造同步结果。
- 手工资产配置 IP 后可启用 Ping 监测；后台按固定间隔更新在线状态，也可在资产列表中立即检测。
- 资产二维码是公开只读链接，扫码后可查看类型、归属、位置和在线状态，不提供编辑权限。

## 运行架构

```text
Windows/macOS Agent
        |
        | HTTPS/HTTP check-in
        v
Linux + Docker Compose
  Express + Node.js 24
        |
        v
SQLite named volume (/data/assets.db)
```

生产容器使用非 root 用户运行，只增加 Ping 所需的 `NET_RAW` capability。数据库、环境密钥、附件目录、依赖目录和构建产物不会提交到 Git。

## Linux 快速部署

要求：

- Linux x86_64 或 arm64
- Docker Engine 24+
- Docker Compose v2
- 至少 1 GB 可用内存和 1 GB 磁盘

```bash
git clone https://github.com/offscumke/it-asset.git
cd it-asset
./scripts/deploy.sh
```

首次运行会创建权限为当前用户私有的 `.env`，生成管理员密码、Agent 密钥和 JWT 密钥，并在终端显示一次管理员密码。服务健康后访问：

```text
http://SERVER_IP:3001
```

常用状态命令：

```bash
docker compose ps
docker compose logs -f --tail=100 it-asset
curl http://127.0.0.1:3001/api/health
```

## 环境配置

自动部署会生成 `.env`。也可以先从 `.env.example` 创建并修改：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `APP_BIND` | `0.0.0.0` | 发布端口绑定地址 |
| `APP_PORT` | `3001` | Linux 主机端口 |
| `ADMIN_USER` | `admin` | 管理员用户名 |
| `ADMIN_PASS` | 自动生成 | 管理员密码，生产环境必填 |
| `AGENT_SECRET` | 自动生成 | 所有 Agent 上报共享密钥，生产环境必填 |
| `JWT_SECRET` | 自动生成 | 登录令牌签名密钥，生产环境必填 |
| `PUBLIC_BASE_URL` | 空 | 对外访问根地址，用于二维码链接 |
| `TRUST_PROXY` | `0` | 位于可信反向代理后时设为 `1` |
| `CORS_ORIGIN` | 空 | 仅在分离部署前端时设置允许的浏览器来源 |
| `PING_INTERVAL_SECONDS` | `60` | 手工资产后台 Ping 检测间隔，最小 15 秒 |
| `UPLOAD_DIR` | `/data/uploads` | 附件存储目录，生产环境应位于持久化数据卷 |

修改 `.env` 后重新应用：

```bash
docker compose up -d --build
```

## 域名和 HTTPS

手机摄像头扫码应通过 HTTPS 使用。由 Nginx、Caddy、Traefik 或云负载均衡终止 TLS，并在 `.env` 中设置：

```dotenv
APP_BIND=127.0.0.1
PUBLIC_BASE_URL=https://assets.example.com
TRUST_PROXY=1
```

反向代理转发到 `http://127.0.0.1:3001`，并保留 `Host`、`X-Forwarded-For` 和 `X-Forwarded-Proto` 请求头。

## Agent 接入

从服务器 `.env` 读取 `AGENT_SECRET`，不要把它写入仓库或聊天记录。

macOS/Linux Python 环境单次测试：

```bash
python3 agent/agent.py \
  --server https://assets.example.com \
  --agent-secret YOUR_AGENT_SECRET \
  --once
```

持续上报默认每 300 秒一次：

```bash
python3 agent/agent.py \
  --server https://assets.example.com \
  --agent-secret YOUR_AGENT_SECRET
```

macOS 安装包（当前在 Apple Silicon macOS 上生成 arm64 包）：

```bash
bash agent-deploy/macos/build_pkg.sh
```

不要打开 `agent/build/it-asset-agent/it-asset-agent.pkg`：那是 PyInstaller 的内部归档，不是 macOS Installer。生成的真正安装包在 `agent/dist/it-asset-agent-macos-arm64.pkg`，双击它安装后，再运行：

```bash
sudo /usr/local/it-asset-agent/configure.sh \
  --server https://assets.example.com \
  --secret YOUR_AGENT_SECRET
```

也可以直接使用源码目录中的安装脚本：

```bash
sudo bash agent-deploy/macos/install.sh \
  --server https://assets.example.com \
  --secret YOUR_AGENT_SECRET
```

Windows 需要先在 Windows 主机运行 `agent-deploy/windows/build_on_windows.bat` 生成 `it-asset-agent.exe`，再把可执行文件与 `install.bat` 放在同一目录，以管理员身份安装。

## 现有数据库迁移

数据库不会上传 GitHub。要把当前 `server/assets.db` 带到新环境，先安全传输数据库文件，然后在新服务器执行：

```bash
docker compose build
docker compose stop it-asset
./scripts/import-db.sh /path/to/assets.db
docker compose up -d
```

导入脚本拒绝在服务运行时覆盖数据库，并自动修正容器内文件权限。

## 备份与恢复

创建一致性备份：

```bash
./scripts/backup.sh
```

备份保存到本机 `backups/`，脚本会短暂停止服务、复制数据库和附件目录、恢复服务，并输出数据库 SHA-256。恢复数据库和附件时：

```bash
docker compose stop it-asset
./scripts/import-db.sh backups/assets-YYYYMMDD-HHMMSS.db backups/attachments-YYYYMMDD-HHMMSS.tar.gz
docker compose up -d
```

生产环境应再把 `backups/` 同步到独立存储，并定期执行恢复演练。

## 升级与回滚

升级前先备份，然后拉取并重建：

```bash
./scripts/backup.sh
git pull --ff-only
docker compose up -d --build
docker compose ps
```

出现问题时，切回上一个已验证提交，重新构建，再导入升级前备份。

## 本地开发

本地非生产模式保留开发默认凭据：

```bash
cd server
npm install
npm start
```

访问 `http://localhost:3001`，默认账号为 `admin` / `admin123`。这些默认值不会在 `NODE_ENV=production` 下生效。

本地附件默认保存到 `server/uploads/`；生产 Docker 部署保存到 `/data/uploads`，与 SQLite 共用 `it_asset_data` 数据卷。单个附件最大 8 MB，仅允许 PDF、图片、文本、CSV、ZIP 和 XLSX。

## 验证

```bash
npm run check --prefix server
npm test --prefix server
npm audit --omit=dev --prefix server
bash -n scripts/deploy.sh scripts/backup.sh scripts/import-db.sh
docker compose --env-file .env.example config --quiet
docker build -t it-asset:verify .
```

GitHub Actions 会在 push 和 pull request 时执行同等检查。
