# PindaoBot · Telegram 频道资料机器人

一款开源的 **Telegram 资料管理与分发机器人**，适合频道运营、私域资料整理、关键词检索与批量发布。

支持：**上传资料 → 关键词搜索 → 发布到频道 → 网页相册分享**，并提供 **金库备份**，方便更换 Bot Token 后迁移媒体。

---

## 主要功能

| 模块 | 说明 |
|------|------|
| 📤 资料上传 | 按关键词上传图片、视频、文档等，自动分批成组 |
| 🔍 关键词搜索 | 支持连写、空格分隔、多词连搜（如 `优米樊樊` / `优米 樊樊`） |
| 📢 内容发布 | 一键发布到指定频道，多关键词按顺序串行发布 |
| 🖼️ 网页相册 | 从资料库或手动发图制作网页链接，可连续收录多组 |
| 📡 频道管理 | 在线添加/删除频道，无需重启 |
| 🔘 按钮制作 | 为文案/媒体添加 URL 按钮 |
| 📣 群发消息 | 向使用过机器人的用户群发 |
| 🗄️ 金库备份 | 媒体备份到指定频道，换 Token 后自动认领 `file_id` |
| 🐳 Docker 部署 | 提供完整 Docker Compose 配置，适合 Linux 服务器 |

---

## 适用场景

- Telegram 频道资料更新与分发  
- 按关键词快速查找、发送资料包  
- 制作可分享的网页相册链接  
- 多频道、多管理员协作运营  

## 引用搜索结果管理资料组

更新并重启机器人后，先搜索关键词，再引用目标组中任意一条媒体消息：

- 回复 `删除`：删除被引用的整组资料。最后一组删除后，关键词从普通资料库消失。
- 回复 `替换`：弹出 `替换文案` 和 `替换照片` 按钮。
- 选择 `替换文案` 后发送新文字，即可覆盖这一组的文案，保留关键词标签。
- 选择 `替换照片` 后发送新照片（可多张），全部发送完点击 `完成替换`。原文案及视频等其他文件保留。
- 选择 `整组替换（文案＋照片/视频）` 后发送新照片／视频和文案，文字可随媒体或单独发送。点击 `完成替换` 查看摘要，再点 `确认整组替换`，一次覆盖整组旧资料。
- 点击取消或回复 `取消` 可退出替换；替换会话有效期为 30 分钟，重启后需要重新选择。

其他资料组、好评库和独立网页相册不受影响。普通用户只能管理自己的资料，超级管理员可以管理全部资料。
修改保存到资料库，重新搜索可看到新内容；聊天中的旧消息和已发布的频道消息不会追溯修改。
引用记录会保存到数据库；更新前发出的搜索消息没有记录，需要重新搜索后操作。

本地验证：`npm run build` 后运行 `node scripts/reply-group-check.cjs`，使用临时数据库和模拟 Telegram 消息。

“查看资料”中，水印管理下方新增 `🕘 最近搜索`。按个人最近 30 天的搜索次数排序，同次数按最后搜索时间排序；关键词使用三列分页按钮，点击即可查看资料。文字搜索和点击关键词均计数，未找到的关键词不计数。历史记录可从日志补录，新搜索实时累计，重启保留；已删除或无权访问的关键词不显示。验证脚本：`node scripts/recent-search-check.cjs`。

---

## 环境要求

- **Node.js 18+**（本地开发）
- 或 **Docker 20+**（生产部署推荐）
- 可访问 Telegram API 的网络环境

---

## 快速开始（本地）

```bash
git clone https://github.com/yummy021414/tg-pindao-bot.git
cd tg-pindao-bot

npm install
cp .env.example .env
# 编辑 .env，填入 BOT_TOKEN、SUPER_ADMIN_ID、CHANNEL_IDS 等

npm run dev          # 开发模式
# 或
npm run build && npm start
```

### 必填配置（`.env`）

| 变量 | 说明 |
|------|------|
| `BOT_TOKEN` | BotFather 创建的机器人 Token |
| `SUPER_ADMIN_ID` | 超级管理员的 Telegram 数字 ID |
| `CHANNEL_IDS` | 绑定频道 ID，多个用英文逗号分隔 |
| `PERSISTENT_CHANNEL_ID` | 金库备份频道（换 Token 强烈建议配置） |
| `DOMAIN` | 网页相册访问地址，如 `http://你的域名:3000` |

> ⚠️ 请勿将 `.env` 和 `data/` 提交到 Git，其中包含密钥与用户数据。

---

## Docker 部署（推荐）

```bash
cd deploy
cp env.example .env    # 填写真实配置
docker compose up -d --build
docker logs -f pindaobot
```

更新代码后：

```bash
cd /root/pindaobot          # 你的项目目录
git pull origin main
cd deploy
docker compose up -d --build --force-recreate
```

---

## 换 Bot Token（金库流程）

1. `npm run vault:status` — 查看备份覆盖率  
2. `npm run vault:sync` — 用**旧 Token** 把媒体同步到金库频道  
3. `npm run vault:claim` — 用**新 Token** 认领新的 `file_id`  
4. 将 `.env` 中 `BOT_TOKEN` 换成新 Token，重启服务  

认领前需配置 `NEW_BOT_TOKEN`、`CLAIM_TO_CHAT_ID`，并先给新 Bot 发送 `/start`。

---

## 项目结构

```
src/          机器人核心源码（Bot、Handler、数据库、网页服务）
scripts/      运维脚本（金库 sync/claim/status 等）
deploy/       Docker 部署文件
data/         运行数据（本地生成，不纳入 Git）
.env          环境变量（本地配置，不纳入 Git）
```

---

## 发布速度与资料组保护

- 手动发布、上传后发布、定时发布共用频道队列，同一频道内按完整资料组发送，保留组内照片和视频顺序；不同上传者的批次不会合并。
- 去除组间、关键词间和频道间叠加的固定等待，按实际请求耗时控速。不同频道最多同时执行两个发送请求；定时任务继续按持久化游标顺序执行。
- 每次媒体组最多 10 个文件；遇到 Telegram 限流按其返回的等待时间重试。实际图片显示速度还受 Telegram 和客户端网络影响。
- 超时、发送结果不确定或中途失败时暂停该频道，防止盲目重发。暂停状态保存在数据目录的 `publish-paused.json`，重启后仍有效。
- 管理员核对频道最后一组后，可发送 `/publish_resume 频道ID` 恢复后续发布。此命令不会重发失败任务；未完成部分需核对后重新选择发布。

## 技术栈

- Node.js · TypeScript · Telegraf · Express  
- JSON 文件数据库（轻量、易备份）  
- Docker · docker-compose  

---

## 开源协议

MIT License · 欢迎 Fork 与 Issue

历史搜索补录：停止机器人并备份数据库后，使用 `node scripts/import-search-history.cjs --db data/bot.json --log data/bot.log --before <实时统计首次启用的ISO时间>` 预览，再添加 `--apply --bot-stopped` 写入。脚本仅导入截止时间之前、最近30天内的记录，通过用户ID或唯一用户名识别账号，不按昵称猜测。补录标记防止重复执行，保留已有实时统计。日志时间按 Asia/Shanghai 解析。
