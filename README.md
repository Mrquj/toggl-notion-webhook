# Toggl Webhook to Notion Worker

这个项目是一个 Cloudflare Worker，用来接收 Toggl Track webhook，并把时间记录实时同步到 Notion 数据库。

## Notion 数据库字段

最少需要这两列：

| 列名 | 类型 | 用途 |
| --- | --- | --- |
| `Name` | Title | 时间记录标题 |
| `Toggl ID` | Number | 用来查重和更新同一条 Toggl 记录 |

可选列会自动识别，存在且类型匹配时才会写入：

| 列名 | 推荐类型 |
| --- | --- |
| `Start` | Date |
| `End` | Date |
| `Duration Seconds` | Number |
| `Project` | Rich text |
| `Client` | Rich text |
| `Task` | Rich text |
| `Tags` | Multi-select |
| `Billable` | Checkbox |
| `User` | Rich text |
| `Workspace ID` | Number |
| `Status` | Select |
| `Last Event` | Rich text |
| `Toggl URL` | URL |

如果你的标题列或 Toggl ID 列不是默认名字，可以设置：

```sh
NOTION_TITLE_PROPERTY=你的标题列名
NOTION_TOGGL_ID_PROPERTY=你的ID列名
```

## 本地配置

复制示例配置：

```sh
copy .dev.vars.example .dev.vars
```

填写这些值：

| 变量 | 说明 |
| --- | --- |
| `NOTION_TOKEN` | Notion integration token |
| `NOTION_DATA_SOURCE_ID` | 推荐使用，Notion 数据源 ID |
| `NOTION_DATABASE_ID` | 旧版兼容，只在没填 `NOTION_DATA_SOURCE_ID` 时使用 |
| `TOGGL_WEBHOOK_SECRET` | Toggl webhook 的 signing secret |
| `EXPECTED_CALLBACK_URL` | 可选，用来确认事件确实发给这个 Worker 地址 |

Notion 需要把目标数据库分享给你的 integration，并授予读取、插入、更新内容权限。

## 运行

```sh
npm install
npm test
npm run check
npm run dev
```

本地启动后，Toggl 需要公网地址才能回调。可以先部署到 Cloudflare 再在 Toggl 里配置 webhook。

## 部署

```sh
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put TOGGL_WEBHOOK_SECRET
npx wrangler secret put NOTION_DATA_SOURCE_ID
npx wrangler secret put EXPECTED_CALLBACK_URL
npm run deploy
```

部署后，把这个地址填到 Toggl webhook：

```text
https://你的-worker.workers.dev/webhook
```

Toggl 事件建议选择：

```json
[
  { "entity": "time_entry", "action": "created" },
  { "entity": "time_entry", "action": "updated" },
  { "entity": "time_entry", "action": "deleted" }
]
```

Worker 会自动处理 Toggl 的验证 ping：收到带 `validation_code` 的 ping 时返回同一个 `validation_code`。

## Google Calendar 同步到 aTimeLogger

本项目也包含一个本地脚本，用于把 Google Calendar 的“课程表”日历同步到 aTimeLogger Pro 的 `工作` 活动类型。

完整配置、平台支持、自动同步、迁移备份与故障排查请阅读：[Google Calendar 同步到 aTimeLogger Pro：完整配置与使用指南](./ATIMELOGGER_SYNC_GUIDE.zh-CN.md)。

先在 `.dev.vars` 中配置：

| 变量 | 说明 |
| --- | --- |
| `GOOGLE_CALENDAR_ICS_URL` | Google Calendar 课程表日历的私密 iCal 地址 |
| `SYNC_TIMEZONE` | 默认 `Asia/Shanghai` |
| `ATIMELOGGER_TOKEN` | aTimeLogger Pro Bearer token |
| `ATIMELOGGER_ACTIVITY_TYPE_NAME` | 默认 `工作`；如果是分组，会自动使用该分组下第一个可写活动 |
| `ATIMELOGGER_DRY_RUN` | `true` 时只检查不写入 |

先测试不写入：

```sh
npm run sync:atimelogger-calendar -- --dry-run
```

确认无误后，把 `.dev.vars` 中的 `ATIMELOGGER_DRY_RUN` 改为 `false` 或删除，再运行：

```sh
npm run sync:atimelogger-calendar
```

脚本会用 `Google Calendar Event ID` 写入备注并在下次运行时查重，避免重复导入同一节课。

也可以指定某一天同步：

```sh
npm run sync:atimelogger-calendar -- --date 2026-06-07
```

Windows 可以双击 `run_atimelogger_sync_choose_date.pyw`；带桌面环境的 Linux 可以运行 `python3 run_atimelogger_sync_choose_date.py`。两者打开同一个程序，包含三个页面：

- `手动同步`：选择单日或连续 7 天，支持今天、昨天、一周前、一个月前、本周、上周、最近 7 天，也可以手动输入任意 `YYYY-MM-DD` 起始日期。
- `日历`：添加多个 Google Calendar 私密 iCal 地址，并多选需要同步的日历。保存后的选择同时用于手动同步和后台自动同步。
- `自动同步`：设置登录系统后同步、打开脚本时同步，或按每天、每隔 2 天、每隔 7 天、每周固定一天和固定时间后台同步。

自动同步直接运行本地脚本，不依赖 Codex。Windows 使用计划任务和登录启动项；Linux 使用用户级 `systemd` 定时器和 XDG 登录启动项，不需要 root 权限。Linux 桌面需要安装 Python Tk，例如 Ubuntu/Debian 上的 `python3-tk`。静默运行结果保存在 `logs/atimelogger-auto-sync.log`。

默认课程表继续从 `.dev.vars` 的 `GOOGLE_CALENDAR_ICS_URL` 读取。其他日历保存在本地 `.atimelogger-calendars.json`，该文件含私密 iCal 地址，已经加入 `.gitignore`。

`configure_atimelogger_auto_sync.pyw` 仍可作为快捷入口，打开同一个自动同步设置页面。
