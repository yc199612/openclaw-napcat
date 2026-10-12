# openclaw-napcat

[English](./README_EN.md) | 中文

OpenClaw 的 QQ 消息通道插件，基于 [NapCat](https://github.com/NapNeko/NapCatQQ) 的 OneBot 11 反向 WebSocket 协议。

让 AI 助手通过自然语言完全操控 QQ 互动——点赞、戳一戳、禁言、踢人、查询资料、群管理等等。

> **本仓库是 [@hyl_aa/openclaw-napcat](https://github.com/Aliang1337/openclaw-napcat) 原插件的更新维护版本。**
> 在原插件功能基础上，适配 openclaw 2026.9.x / 2026.10.x 系列的新插件 SDK 与网关协议。原插件的全部功能（45 个 QQ 工具、语音转文字、多账号等）完整保留。

## 主要更新（相对原版）

| 更新项 | 说明 |
|------|------|
| **openclaw 2026.10.x 兼容** | 适配 2026.10.2 SDK 移除的 `plugin-sdk/channel-lifecycle` 子路径（`createAccountStatusSink` 等导出已并入 `channel-outbound`）；同版本号 v2.1.0 依然兼容 2026.9.x |
| **openclaw 2026.9.x SDK 迁移** | 全部 16 个 `openclaw/plugin-sdk/*` 子路径 import 适配新版规范；`registerChannel` 新签名（dock 参数已移除） |
| **connect.challenge 握手兼容** | 新增网关路径模式：通过 `registerHttpRoute` + `handleUpgrade` 在 openclaw 网关端口上注册插件 WS 路由，NapCat 连接 `ws://<host>:<port>/napcat/ws` 时由插件直接接管，**彻底绕过 2026.9.x 网关对纯 OneBot 11 客户端无法应答的 connect.challenge 强制握手** |
| **规范化 session key** | 会话 key 改用官方 `buildAgentSessionKey` 构造（`agent:<agentId>:...` 格式），修复旧版内联拼接导致的 `SessionCanonicalKeyMigrationRequiredError` 拒写问题（该问题 `openclaw doctor --fix` 无法根治） |
| **防双发（回复去重）** | AI 调用 `qq_send_message` 等工具回复后，回合末尾的正常回复通道自动抑制，不再重复发送同一条消息（`src/reply-guard.ts`） |
| **配置界面元数据** | `openclaw.plugin.json` 的 `channelConfigs` 按新版规范格式重写，Web 配置界面正常渲染表单 |

## 功能特性

- **45 个 AI Agent 工具** —— AI 可通过自然语言执行 QQ 操作
- **语音转文字（STT）** —— 语音消息自动转录为文字后再发给 AI
- **@提及解析** —— 识别消息中的 `@QQ号` 并映射为用户 ID
- **群管理** —— 完整管理工具集：禁言、踢人、设管理、改群名、发公告
- **多账号** —— 支持多个 NapCat 机器人账号

## Agent 工具列表

### 查询工具

| 工具 | 功能 | 仅群主 |
|------|------|:------:|
| `qq_like_user` | 给用户点赞 | |
| `qq_get_user_info` | 获取用户资料（昵称、年龄、签名等） | |
| `qq_get_group_info` | 获取群信息（群名、成员数） | |
| `qq_get_group_member_info` | 获取群内某成员的详细信息 | |
| `qq_get_friend_list` | 获取机器人好友列表 | |
| `qq_get_group_list` | 获取机器人群列表 | |
| `qq_get_group_member_list` | 获取群全部成员列表 | |
| `qq_get_group_honor_info` | 获取群荣誉信息（龙王等） | |

### 消息历史与上下文

| 工具 | 功能 | 仅群主 |
|------|------|:------:|
| `qq_get_group_msg_history` | 获取群聊历史消息 | |
| `qq_get_friend_msg_history` | 获取私聊历史消息 | |
| `qq_get_essence_msg_list` | 获取群精华消息列表 | |

### 互动工具

| 工具 | 功能 | 仅群主 |
|------|------|:------:|
| `qq_poke` | 戳一戳 | |
| `qq_recall_message` | 撤回消息 | Yes |
| `qq_set_msg_emoji_like` | 给消息添加表情回应 | |
| `qq_ocr_image` | OCR 图片文字识别 | |
| `qq_translate_en2zh` | 英译中翻译 | |
| `qq_mark_msg_as_read` | 标记消息为已读 | |

### 消息发送

| 工具 | 功能 | 仅群主 |
|------|------|:------:|
| `qq_send_message` | 发送文本/图片/语音/视频消息 | |
| `qq_upload_file` | 上传文件到群聊或私聊 | |
| `qq_forward_message` | 转发消息 | |
| `qq_send_group_forward_msg` | 发送群合并转发消息 | |
| `qq_send_private_forward_msg` | 发送私聊合并转发消息 | |
| `qq_download_file` | 下载文件到机器人本地 | Yes |

### 精华消息管理

| 工具 | 功能 | 仅群主 |
|------|------|:------:|
| `qq_set_essence_msg` | 设置精华消息 | Yes |
| `qq_delete_essence_msg` | 移除精华消息 | Yes |

### 好友管理

| 工具 | 功能 | 仅群主 |
|------|------|:------:|
| `qq_set_friend_remark` | 设置好友备注 | Yes |
| `qq_delete_friend` | 删除好友 | Yes |

### 群管理工具

| 工具 | 功能 | 仅群主 |
|------|------|:------:|
| `qq_mute_group_member` | 禁言群成员 | Yes |
| `qq_kick_group_member` | 踢出群成员 | Yes |
| `qq_set_group_card` | 设置群名片 | Yes |
| `qq_set_group_admin` | 设置/取消群管理员 | Yes |
| `qq_set_group_name` | 修改群名称 | Yes |
| `qq_set_group_whole_ban` | 全员禁言开关 | Yes |
| `qq_set_group_special_title` | 设置群成员专属头衔 | Yes |
| `qq_set_group_leave` | 退出群聊 | Yes |
| `qq_set_group_portrait` | 设置群头像 | Yes |
| `qq_set_group_sign` | 群签到打卡 | |
| `qq_set_group_remark` | 设置群备注 | Yes |
| `qq_get_group_at_all_remain` | 查询 @全体成员 剩余次数 | |

### 群公告管理

| 工具 | 功能 | 仅群主 |
|------|------|:------:|
| `qq_send_group_notice` | 发送群公告 | Yes |
| `qq_get_group_notice` | 获取群公告列表 | |
| `qq_delete_group_notice` | 删除群公告 | Yes |

### 群文件管理

| 工具 | 功能 | 仅群主 |
|------|------|:------:|
| `qq_get_group_root_files` | 获取群文件根目录列表 | |
| `qq_get_group_file_url` | 获取群文件下载链接 | |
| `qq_create_group_file_folder` | 创建群文件夹 | Yes |
| `qq_delete_group_file` | 删除群文件 | Yes |

### 请求处理

| 工具 | 功能 | 仅群主 |
|------|------|:------:|
| `qq_handle_friend_request` | 处理好友请求 | Yes |
| `qq_handle_group_request` | 处理加群请求 | Yes |

## 前置要求

- 已安装并运行 [OpenClaw](https://github.com/openclaw/openclaw)
- 已运行 [NapCat](https://github.com/NapNeko/NapCatQQ) 并开启 HTTP API
- Node.js 22+

## 安装

**方式一：从 Gitee / GitHub 克隆（推荐）**

```bash
cd ~/.openclaw/extensions
# Gitee
git clone https://gitee.com/yc1996/openclaw-napcat.git napcat
# 或 GitHub
git clone https://github.com/yc199612/openclaw-napcat.git napcat
cd napcat && npm install --omit=dev
```

**方式二：手动复制**

将本仓库文件复制到 `~/.openclaw/extensions/napcat/`，执行 `npm install --omit=dev`，然后在 openclaw 配置的 `plugins.load.paths` 中添加该路径。

> 本插件未发布 npm 包。如需通过 npm 安装，请使用原作者的 @hyl_aa/openclaw-napcat（适用于 openclaw 2026.5.x 及更早版本）。

## 配置

在 OpenClaw 配置中添加（`openclaw config edit`）：

```json
{
  "channels": {
    "napcat": {
      "httpApi": "http://127.0.0.1:3000",
      "accessToken": "你的token",
      "selfId": "123456789",
      "dmPolicy": "allowlist",
      "allowFrom": ["好友QQ号"],
      "groupPolicy": "allowlist",
      "groupAllowFrom": ["群号"]
    }
  }
}
```

### 配置字段说明

| 字段 | 说明 |
|------|------|
| `httpApi` | NapCat OneBot 11 HTTP API 地址 |
| `accessToken` | API 鉴权 token（可选） |
| `selfId` | 机器人自身 QQ 号（用于 @机器人检测） |
| `dmPolicy` | 私聊策略：`allowlist` / `pairing` / `open` / `disabled` |
| `allowFrom` | 允许私聊的 QQ 号列表 |
| `groupPolicy` | 群聊策略：`allowlist` / `open` / `disabled` |
| `groupAllowFrom` | 允许在群聊中触发的 QQ 号列表 |
| `wsMode` | 反向 WS 模式：`both`（默认）/ `gateway` / `standalone`，详见下节 |
| `gatewayPath` | 网关路径模式的 URL 路径（默认 `/napcat/ws`） |

### 反向 WebSocket 模式与 connect.challenge 兼容（openclaw 2026.9.x）

openclaw 2026.9.x 网关对所有直连网关端口的 WebSocket 连接强制下发 `connect.challenge` 握手挑战，纯 OneBot 11 客户端（NapCat）无法应答，连接必然超时断开。

本插件通过 `registerHttpRoute` 在网关上注册插件自己的 WS 路由（openclaw 插件路由的分发优先级高于网关默认 WS 处理器），NapCat 连接 `ws://<openclaw主机>:<网关端口>/napcat/ws` 时由插件直接接管——**不会收到 connect.challenge，纯 OneBot 11 通信**。

**wsMode 取值：**

| 值 | 行为 |
|------|------|
| `both`（默认） | 网关路径 + 独立端口（18800+账号序号）双通道并存，平滑迁移 |
| `gateway` | 仅网关路径模式（推荐，解决 connect.challenge） |
| `standalone` | 仅独立端口模式（旧行为，NapCat 需单独配置 18800 端口地址） |

**NapCat 侧配置：** 将反向 WS 地址改为

```
ws://<openclaw主机>:<网关端口>/napcat/ws
```

多账号时用 `?account=<accountId>` 区分，或依赖 NapCat 自动携带的 `x-self-id` 头路由。鉴权沿用 OneBot 11 标准（`Authorization: Bearer <token>` 或 `?access_token=<token>`）。

### 回复防双发（qq_send_message 去重）

当 AI 在一个回合内通过 `qq_send_message` 工具发送消息后，回合末尾的正常回复通道会自动抑制——用户不会收到重复的第二条消息（正常对话不受影响，新消息开启新回合后自动恢复）。若需观察该机制，可在日志中搜索 `reply suppressed`。

### 从原版插件升级

若之前使用原版 @hyl_aa/openclaw-napcat（openclaw 2026.5.x 及更早）：

1. 覆盖插件目录文件后**完全重启** openclaw（jiti 模块缓存不支持热替换）
2. NapCat 反向 WS 地址按上节改为网关路径模式地址
3. 启动日志如出现 `SessionCanonicalKeyMigrationRequiredError`，停服执行一次 `openclaw doctor --fix` 迁移旧会话数据
4. openclaw 配置文件无需改动（`wsMode` 默认 `both`，新旧两种连接方式并存）

**重要：** 需要在 OpenClaw 配置中将 `tools.profile` 设置为 `"full"`，否则 `qq_*` 工具会被默认的 `"coding"` profile 过滤掉。

## 使用示例

配置完成后，直接在 QQ 中与 AI 对话即可：

- "帮我给 3870871935 点赞" —— AI 调用 `qq_like_user`
- "帮我分析 @某人 的签名" —— AI 从 @提及中提取 QQ 号，调用 `qq_get_user_info`
- "查看群成员列表" —— AI 调用 `qq_get_group_member_list`
- "把 @某人 禁言10分钟" —— AI 调用 `qq_mute_group_member`（仅群主）
- "发个群公告：明天开会" —— AI 调用 `qq_send_group_notice`（仅群主）
- "查看群里最近的聊天记录" —— AI 调用 `qq_get_group_msg_history`
- "把这条消息设为精华" —— AI 调用 `qq_set_essence_msg`（仅群主）
- "识别一下这张图上的文字" —— AI 调用 `qq_ocr_image`
- "看看群文件里有什么" —— AI 调用 `qq_get_group_root_files`

## 语音消息

启用语音 STT 后（`tools.media.audio.enabled: true`），语音消息会自动转录为文字再发送给 AI 模型。

## 项目结构

```
.
├── index.ts                 # 插件入口
├── package.json
├── openclaw.plugin.json     # 插件元数据
└── src/
    ├── accounts.ts          # 多账号解析
    ├── api.ts               # OneBot 11 HTTP API 客户端
    ├── channel.ts           # Channel 插件定义
    ├── config-schema.ts     # 配置 JSON Schema + UI 提示
    ├── gateway-ws.ts        # 网关路径 WS 入口（connect.challenge 兼容）
    ├── monitor.ts           # WebSocket 消息监听 + STT
    ├── probe.ts             # 连接探测 / 健康检查
    ├── reply-guard.ts       # 回合内回复防双发标记
    ├── runtime.ts           # 运行时上下文
    ├── send.ts              # 消息发送
    ├── tools.ts             # 45 个 AI Agent 工具
    └── types.ts             # TypeScript 类型定义
```

## 许可证

MIT（基于原作者 Aliang1337 的 MIT 许可继续发布）
