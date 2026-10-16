#!/bin/bash

# Telegram频道管理机器人 - Linux一键安装脚本
# 适用于 Ubuntu/Debian/CentOS/RHEL 系统

set -e  # 遇到错误立即退出

echo "🚀 开始安装Telegram频道管理机器人..."

# 检查系统类型
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$NAME
    VER=$VERSION_ID
else
    echo "❌ 无法检测操作系统类型"
    exit 1
fi

echo "📋 检测到系统: $OS $VER"

# 更新系统包管理器
echo "🔄 更新系统包管理器..."
if command -v apt-get &> /dev/null; then
    sudo apt-get update
    PACKAGE_MANAGER="apt-get"
elif command -v yum &> /dev/null; then
    sudo yum update -y
    PACKAGE_MANAGER="yum"
elif command -v dnf &> /dev/null; then
    sudo dnf update -y
    PACKAGE_MANAGER="dnf"
else
    echo "❌ 不支持的包管理器"
    exit 1
fi

# 安装必要的系统依赖
echo "📦 安装系统依赖..."
if [ "$PACKAGE_MANAGER" = "apt-get" ]; then
    sudo apt-get install -y curl wget git build-essential python3 python3-pip ffmpeg fonts-noto-cjk
elif [ "$PACKAGE_MANAGER" = "yum" ] || [ "$PACKAGE_MANAGER" = "dnf" ]; then
    sudo $PACKAGE_MANAGER install -y curl wget git gcc gcc-c++ make python3 python3-pip
    echo '启用水印前，请按发行版安装 FFmpeg (drawtext/libx264) 和 Noto CJK 字体，并配置 WATERMARK_FONT_FILE。'
fi

# 检查Node.js是否已安装
if ! command -v node &> /dev/null; then
    echo "📦 安装Node.js..."
    
    # 使用NodeSource仓库安装最新LTS版本
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    
    if [ "$PACKAGE_MANAGER" = "apt-get" ]; then
        sudo apt-get install -y nodejs
    elif [ "$PACKAGE_MANAGER" = "yum" ] || [ "$PACKAGE_MANAGER" = "dnf" ]; then
        # 对于CentOS/RHEL，使用不同的安装方法
        curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash -
        sudo $PACKAGE_MANAGER install -y nodejs
    fi
else
    echo "✅ Node.js 已安装: $(node --version)"
fi

# 检查npm是否可用
if ! command -v npm &> /dev/null; then
    echo "❌ npm 未找到，请检查Node.js安装"
    exit 1
fi

echo "✅ Node.js 版本: $(node --version)"
echo "✅ npm 版本: $(npm --version)"

# 创建项目目录
PROJECT_DIR="/opt/telegram-bot"
echo "📁 创建项目目录: $PROJECT_DIR"
sudo mkdir -p $PROJECT_DIR
sudo chown $USER:$USER $PROJECT_DIR

# 复制项目文件
echo "📋 复制项目文件..."
cp -r . $PROJECT_DIR/
cd $PROJECT_DIR

# 安装Node.js依赖
echo "📦 安装Node.js依赖..."
npm install

# 编译TypeScript
echo "🔨 编译TypeScript..."
npx tsc

# 创建环境配置文件
if [ ! -f .env ]; then
    echo "⚙️ 创建环境配置文件..."
    cat > .env << EOF
# Telegram Bot配置
BOT_TOKEN=your_bot_token_here
SUPER_ADMIN_ID=your_admin_id_here

# 频道配置
SOURCE_CHANNELS=
TARGET_CHANNELS=

# 数据库配置
DB_PATH=./data/bot.json

# 运行配置
IS_RUNNING=true
EOF
    echo "📝 请编辑 .env 文件配置您的机器人参数"
fi

# 创建数据目录
mkdir -p data

# 创建systemd服务文件
echo "🔧 创建系统服务..."
sudo tee /etc/systemd/system/telegram-bot.service > /dev/null << EOF
[Unit]
Description=Telegram Channel Management Bot
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$PROJECT_DIR
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# 重新加载systemd配置
sudo systemctl daemon-reload

# 设置文件权限
chmod +x install.sh
chmod +x start.sh
chmod +x stop.sh

echo ""
echo "🎉 安装完成！"
echo ""
echo "📋 下一步操作："
echo "1. 编辑配置文件: nano $PROJECT_DIR/.env"
echo "2. 启动服务: sudo systemctl start telegram-bot"
echo "3. 设置开机自启: sudo systemctl enable telegram-bot"
echo "4. 查看状态: sudo systemctl status telegram-bot"
echo "5. 查看日志: sudo journalctl -u telegram-bot -f"
echo ""
echo "🔧 管理命令："
echo "  启动: sudo systemctl start telegram-bot"
echo "  停止: sudo systemctl stop telegram-bot"
echo "  重启: sudo systemctl restart telegram-bot"
echo "  状态: sudo systemctl status telegram-bot"
echo "  日志: sudo journalctl -u telegram-bot -f"
echo ""
echo "📁 项目目录: $PROJECT_DIR"
echo "📄 配置文件: $PROJECT_DIR/.env"
echo "💾 数据文件: $PROJECT_DIR/data/bot.json"
