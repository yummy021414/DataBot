# 按关键词手动水印

普通资料上传和保存发布使用原版；只有“新增好评记录”里的图片保存时自动加水印。好评视频保持原版，混合相册仅处理图片并保持分组。WATERMARK_ENABLED 控制水印服务。

好评图片水印失败时保留上传会话，重试复用已完成的相册。不会自动修改历史好评、频道帖子或评论区消息。

管理员在“查看资料 → 水印管理 → 输入关键词批量加水印”输入例如 11 22 33 44（空格、逗号或换行分隔）。
系统精确匹配关键词，预览待处理数量，确认后只处理本次预览中的资料。11 不会匹配 111。
子管理员仅处理自己的资料；普通用户不可访问。旧全库按钮、过期确认和跨管理员确认均无效。
确认有效期十分钟。暂停或失败后重新选择同一批关键词，可跳过完成的文件并续跑。

按原相册处理，每组最多十个，整组上传和原子保存；金库不会出现处理中间散图。
保留原文件标识和原金库坐标。相册处理结束清理临时文件。
正常上传的关键词标签功能保持不变。

FFmpeg 单线程、单队列、单次尽力降低进程优先级，不要求额外 Linux capability。
下载网络临时故障最多重试一次；永久 HTTP 错误和超限不自动重试。上传结果不确定时不盲目重发。
官方 Bot API 超过 20MB 的源文件需要本地 Bot API 或压缩后重新上传。
失败记录保存在数据库同目录 watermark-failures.jsonl。

## 恢复原版

先备份并停止机器人，预览：
node scripts/rollback-watermarks.cjs --db /path/to/bot.json

确认后执行：
node scripts/rollback-watermarks.cjs --db /path/to/bot.json --apply --bot-stopped

脚本自动备份，仅恢复原媒体标识和坐标及清理水印元数据；保留文案、标签、关键词、批次和其他数据。
缺少原文件标识时中止。不会删除或编辑 Telegram 历史消息，已发布的水印消息不会自动变成原版。

## 验证

npm run build
node scripts/watermark-selected-check.cjs
node scripts/watermark-menu-check.cjs
node scripts/watermark-migration-check.cjs
node scripts/watermark-download-check.cjs
node scripts/watermark-album-check.cjs
node scripts/watermark-check.cjs
node scripts/keyword-tags-check.cjs

离线测试使用临时数据和模拟 Telegram。最后一项水印渲染测试需要 FFmpeg/ffprobe。
