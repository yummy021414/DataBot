# ========================================
# Telegram Bot Docker 镜像
# 多阶段构建，优化镜像大小
# ========================================

# ==================== 构建阶段 ====================
FROM node:20-alpine AS builder

# 设置工作目录
WORKDIR /app

# 安装构建依赖
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    sqlite-dev \
    git

# 复制package文件
COPY package*.json ./

# 安装所有依赖（包括开发依赖）
RUN npm install

# 复制源代码和脚本
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY tsconfig.json ./

# 编译TypeScript
RUN npm run build

# 验证编译结果
RUN test -f dist/index.js || (echo "编译失败！" && exit 1)

# ==================== 生产阶段 ====================
FROM node:20-alpine

# 设置工作目录
WORKDIR /app

# 安装运行时依赖
RUN apk add --no-cache \
    sqlite-libs \
    python3 \
    ffmpeg \
    fontconfig \
    font-noto-cjk \
    tzdata

# 让 FFmpeg drawtext 能稳定找到中文字体
RUN fc-cache -f

# 设置时区为上海
ENV TZ=Asia/Shanghai

# 从builder阶段复制编译后的文件
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/scripts ./scripts
# vault:sync / vault:claim 等脚本用 ts-node 引用 src，需一并带上
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# 创建数据目录
RUN mkdir -p /app/data

# 设置环境变量
ENV NODE_ENV=production

# 数据卷（持久化）
VOLUME ["/app/data"]

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || exit 1

# 启动命令
CMD ["node", "dist/index.js"]
