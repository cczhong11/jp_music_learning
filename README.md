# Japanese Song Shadowing

一个运行在 NAS 或本地 Docker 中的日语歌曲逐句跟读工具。应用使用本地音频、带时间戳的 LRC 歌词和 SQLite 保存学习数据，无需登录。

## 功能

- 上传 M4A、MP3 或 WAV 音频及对应的 LRC 歌词
- 批量导入文件夹内同名的音频与 LRC 文件
- 按歌词时间戳播放、循环当前句
- 上一句、下一句、上一首和下一首导航
- 调整播放速度、练习间隔及句首/句尾缓冲
- 自动生成日语假名和罗马音
- 使用 OpenAI `gpt-5.6-luna` 一键翻译整首歌词
- 手动编辑假名、罗马音和中文翻译
- 浏览器录音、回放并保存跟读录音
- 使用 SQLite 保存歌曲、翻译、录音索引及练习进度
- 响应式网页，支持电脑和手机

## 运行要求

- Docker Engine
- Docker Compose v2
- Bash（使用 `deploy.sh` 时需要）
- OpenAI API Key（仅“一键翻译整首歌”需要）

## 快速开始

1. 创建环境文件：

   ```bash
   cp .env.example .env
   ```

2. 编辑 `.env`。如果需要自动翻译，填写 OpenAI API Key：

   ```dotenv
   OPENAI_API_KEY=your_api_key
   OPENAI_MODEL=gpt-5.6-luna
   NAS_MUSIC_DIR=/volume1/music
   ```

3. 部署：

   ```bash
   ./deploy.sh
   ```

4. 打开：

   ```text
   http://localhost:3009
   ```

局域网中的其他设备可使用 NAS 的 IP，例如 `http://192.168.1.10:3009`。

## 歌曲与歌词格式

每首歌曲必须包含：

- 一个 `.m4a`、`.mp3` 或 `.wav` 音频文件
- 一个带时间戳的 `.lrc` 文件

LRC 示例：

```lrc
[00:10.67]何気ない / あり得ない こと
[00:13.48]くだらない / 譲れない から
[00:16.34]笑えない 笑えない
```

时间戳必须严格递增。中文翻译不是必需的，可在导入后手动填写或使用 OpenAI 自动翻译。

### 文件夹批量导入

音频与歌词必须在同一相对目录中使用相同的基本文件名：

```text
YOASOBI/
├── 01 Orion.m4a
├── 01 Orion.lrc
├── 02 Another Song.m4a
└── 02 Another Song.lrc
```

在歌曲库选择“导入整个文件夹”，应用会自动配对文件、导入新歌曲并跳过已经存在的音频文件。

### 从 NAS 选择性导入

`NAS_MUSIC_DIR` 指向 NAS 宿主机上的音乐目录。Docker 会将它只读挂载到容器的 `/music`：

```dotenv
NAS_MUSIC_DIR=/volume1/music
```

在歌曲库中：

1. 点击“扫描 NAS”。
2. 搜索或浏览同名配对的音频与 LRC。
3. 只勾选需要加入学习库的歌曲。
4. 点击“导入选中的歌曲”。

未勾选的歌曲不会写入 SQLite。NAS 音频保持在原目录，应用只保存只读引用，不会复制第二份；删除学习库中的 NAS 歌曲也不会删除原始音乐文件。

## OpenAI 自动翻译

练习页中的“AI 一键翻译整首”会：

1. 仅发送仍缺少中文翻译的歌词行。
2. 使用环境变量 `OPENAI_MODEL` 指定的模型生成简体中文。
3. 将完整结果写入本地 SQLite。
4. 保留所有已经存在或手动修改的翻译。

API Key 只存在于 Docker 后端，不会发送给浏览器。点击翻译按钮时，歌词文本会发送到 OpenAI API；其他播放和学习功能不依赖 OpenAI。

## 数据与 NAS 存储

默认情况下，Docker 将本地 `./data` 挂载到容器中的 `/data`：

```yaml
volumes:
  - ./data:/data
```

目录包含：

```text
data/
├── learning.sqlite
├── media/
└── recordings/
```

在 NAS 上可以将 `docker-compose.yml` 修改为绝对路径：

```yaml
volumes:
  - /volume1/apps/jp-learning:/data
```

## 备份与恢复

为了得到一致的 SQLite 备份，先停止容器：

```bash
docker compose stop
tar -czf jp-learning-backup.tar.gz data
docker compose start
```

恢复时停止容器，使用备份替换 `data` 目录，然后重新启动。

## 常用命令

```bash
# 重新构建并部署
./deploy.sh

# 查看状态
docker compose ps

# 查看日志
docker compose logs --follow jp-song-shadowing

# 停止
docker compose stop

# 启动
docker compose start

# 运行自动化测试
npm test
```

容器使用 `restart: unless-stopped`：Docker 或 NAS 重启后会自动恢复；如果用户主动停止容器，则不会自行启动。

## 开发

```bash
npm install
npm test
DATA_DIR=./data PORT=3000 npm start
```

本地 Node.js 开发服务器默认使用 `3000`，Docker 对外使用 `3009`。

## 安全说明

- `.env`、数据库、歌曲和录音已被 `.gitignore` 排除。
- 应用没有用户登录系统，建议仅在可信局域网或 VPN 内使用。
- 不建议直接将端口暴露到公共互联网。
