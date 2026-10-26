# 树莓派运行说明（2026-10-26 修复版）

## 这个项目是什么

Cloudflare Worker：接收 Toggl Track 的 webhook，把时间记录实时写入 Notion 数据库。
附带一个本地脚本：把 Google Calendar「课程表」同步到 aTimeLogger Pro。

## 在树莓派上跑之前必须知道的三件事

1. **必须用 Node 22**。wrangler 4.x / miniflare 要求 Node >=22，系统自带 v20.18.1 太旧。
   已在 `~/.local/node22` 装好 Node 22.20.0（不动系统 Node，n8n 等服务不受影响）。
   每次在这个目录跑 npm 命令前，先执行：
   ```sh
   source ./pi-env.sh
   ```
2. **node_modules 必须在本机重装**。原来的是从 Windows 拷贝的，缺 Linux arm64 原生二进制
   （esbuild / workerd / rolldown），`npm install` 修不好，必须 `npm ci`。
   一键重做环境+自检：`./pi-setup.sh`
3. **国内直连 npm 官方源会卡死**，脚本里已固定走 npmmirror。

## 各部分在树莓派上的状态

| 部分 | 状态 | 说明 |
| --- | --- | --- |
| `npx tsc --noEmit` 类型检查 | ✅ 通过 | |
| `npm test` 单元测试 | ✅ 4 个测试全过 | 已加 vitest.config.ts，只跑本项目的 test/；嵌套的 v2/v3 归档子项目用的是 node:test，不归这里管 |
| `npm run deploy`（部署到 Cloudflare） | ✅ 可用 | `wrangler deploy --dry-run` 打包验证通过（15.85 KiB）。真正部署需要先在树莓派上 `npx wrangler login` 或配置 CLOUDFLARE_API_TOKEN |
| `npm run dev`（本地起 Worker） | ❌ 内核限制 | 树莓派 rpt 内核是 39 位虚拟地址空间（CONFIG_ARM64_VA_BITS=39），workerd 的 tcmalloc 需要 48 位，必崩。不是代码问题。替代：用 `npx wrangler dev --remote`（Worker 跑在 Cloudflare 边缘，本地只代理）或直接 deploy |
| `npm run sync:atimelogger-calendar` | ✅ 已跑通（2026-10-26） | ShellCrash 代理已启动并修好开机自启；脚本补了 node:https 下载兜底（fake-ip 下 undici fetch 会超时，https 模块正常），真实同步已成功创建 5 条记录。前提：ShellCrash 在运行（systemctl status shellcrash） |
| Python 界面脚本（.py/.pyw） | ✅ 语法全过 | tkinter 已装，桌面环境下可运行 `python3 run_atimelogger_sync_choose_date.py` |
| 嵌套子项目 v2/v3 的 .mjs | ✅ 语法全过 | 是历史归档版本，日常不用管 |

## 日常怎么用

```sh
cd ~/脚本/'toggl webhook自动实时推送到notion数据库 V3'
source ./pi-env.sh

# 改代码后自检
npm run check && npm test

# 部署 Worker（首次先 npx wrangler login）
npm run deploy

# 课程表同步（需要能访问 Google 的网络/代理）
npm run sync:atimelogger-calendar -- --dry-run   # 先演练
npm run sync:atimelogger-calendar                # 真正同步
```

## 配置

- `.dev.vars`：已含 aTimeLogger 账号和 Google ICS 地址；
  如果要本地跑 Worker，还需补 `NOTION_TOKEN`、`NOTION_DATA_SOURCE_ID`、`TOGGL_WEBHOOK_SECRET`
  （格式见 .dev.vars.example；正式部署用 `npx wrangler secret put XXX` 设置）。
