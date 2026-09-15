# openclaw-napcat

English | [中文](./README.md)

OpenClaw extension for QQ messaging via [NapCat](https://github.com/NapNeko/NapCatQQ) (OneBot 11 reverse WebSocket).

Let your AI assistant fully control QQ interactions through natural language -- like, poke, mute, kick, query user profiles, manage groups, and more.

> **This repository is an updated maintenance fork of the original [@hyl_aa/openclaw-napcat](https://github.com/Aliang1337/openclaw-napcat) plugin.**
> It adapts the plugin to the openclaw 2026.9.x plugin SDK and gateway protocol while keeping every original feature (45 QQ tools, voice-to-text, multi-account, etc.) fully intact.

## What's New (vs. the original)

| Update | Description |
|------|------|
| **openclaw 2026.9.x SDK migration** | All 16 `openclaw/plugin-sdk/*` subpath imports adapted to the new SDK; new `registerChannel` signature (dock parameter removed) |
| **connect.challenge handshake compatibility** | New gateway-path mode: registers a plugin WS route on the openclaw gateway port via `registerHttpRoute` + `handleUpgrade`. NapCat connections to `ws://<host>:<port>/napcat/ws` are handled directly by the plugin, **fully bypassing the connect.challenge mandatory handshake that plain OneBot 11 clients cannot answer on 2026.9.x gateways** |
| **Canonical session keys** | Session keys now built with the official `buildAgentSessionKey` (`agent:<agentId>:...` format); fixes `SessionCanonicalKeyMigrationRequiredError` write rejections caused by the old inline key concatenation (not curable by `openclaw doctor --fix`) |
| **Duplicate-reply guard** | After the agent replies via `qq_send_message` (or other send tools), the end-of-turn normal reply channel is suppressed automatically — no more duplicate messages (`src/reply-guard.ts`) |
| **Config UI metadata** | `openclaw.plugin.json` `channelConfigs` rewritten to the new schema; the web config UI renders the form correctly |

## Features

- **45 AI Agent Tools** -- AI can execute QQ actions via natural language commands
- **Voice-to-Text (STT)** -- Auto-transcribes voice messages before sending to AI
- **@Mention Resolution** -- Recognizes `@QQNumber` in messages and maps to user IDs
- **Group Management** -- Full admin toolkit: mute, kick, set admin, rename group, announcements
- **Multi-Account** -- Supports multiple NapCat bot accounts

## Agent Tools

### Query Tools

| Tool | Description | Owner Only |
|------|-------------|:----------:|
| `qq_like_user` | Give a user thumbs-up (like) | |
| `qq_get_user_info` | Get user profile (nickname, age, signature, etc.) | |
| `qq_get_group_info` | Get group info (name, member count) | |
| `qq_get_group_member_info` | Get a member's info within a group | |
| `qq_get_friend_list` | Get bot's friend list | |
| `qq_get_group_list` | Get bot's group list | |
| `qq_get_group_member_list` | Get all members of a group | |
| `qq_get_group_honor_info` | Get group honor/achievements (Dragon King, etc.) | |

### Message History & Context

| Tool | Description | Owner Only |
|------|-------------|:----------:|
| `qq_get_group_msg_history` | Get group chat message history | |
| `qq_get_friend_msg_history` | Get private chat message history | |
| `qq_get_essence_msg_list` | Get group essence (pinned) message list | |

### Interaction Tools

| Tool | Description | Owner Only |
|------|-------------|:----------:|
| `qq_poke` | Send a poke/nudge to a user | |
| `qq_recall_message` | Recall (delete) a sent message | Yes |
| `qq_set_msg_emoji_like` | React to a message with an emoji | |
| `qq_ocr_image` | OCR text recognition on an image | |
| `qq_translate_en2zh` | Translate English to Chinese | |
| `qq_mark_msg_as_read` | Mark messages as read | |

### Messaging

| Tool | Description | Owner Only |
|------|-------------|:----------:|
| `qq_send_message` | Send text/image/voice/video messages | |
| `qq_upload_file` | Upload a file to group or private chat | |
| `qq_forward_message` | Forward a message | |
| `qq_send_group_forward_msg` | Send merged forward message to group | |
| `qq_send_private_forward_msg` | Send merged forward message to private chat | |
| `qq_download_file` | Download a file to bot's local storage | Yes |

### Essence Message Management

| Tool | Description | Owner Only |
|------|-------------|:----------:|
| `qq_set_essence_msg` | Pin a message as essence | Yes |
| `qq_delete_essence_msg` | Remove a message from essence | Yes |

### Friend Management

| Tool | Description | Owner Only |
|------|-------------|:----------:|
| `qq_set_friend_remark` | Set a friend's remark/alias | Yes |
| `qq_delete_friend` | Delete a friend | Yes |

### Group Management

| Tool | Description | Owner Only |
|------|-------------|:----------:|
| `qq_mute_group_member` | Mute a member for specified duration | Yes |
| `qq_kick_group_member` | Kick a member from a group | Yes |
| `qq_set_group_card` | Set member's display name in group | Yes |
| `qq_set_group_admin` | Set/unset group admin | Yes |
| `qq_set_group_name` | Change group name | Yes |
| `qq_set_group_whole_ban` | Toggle whole-group mute | Yes |
| `qq_set_group_special_title` | Set member's special title | Yes |
| `qq_set_group_leave` | Leave a group | Yes |
| `qq_set_group_portrait` | Set group avatar | Yes |
| `qq_set_group_sign` | Daily group sign-in/check-in | |
| `qq_set_group_remark` | Set group remark (bot-side note) | Yes |
| `qq_get_group_at_all_remain` | Query remaining @all quota | |

### Group Notice Management

| Tool | Description | Owner Only |
|------|-------------|:----------:|
| `qq_send_group_notice` | Send group announcement | Yes |
| `qq_get_group_notice` | Get group announcements | |
| `qq_delete_group_notice` | Delete a group announcement | Yes |

### Group File Management

| Tool | Description | Owner Only |
|------|-------------|:----------:|
| `qq_get_group_root_files` | List files in group root directory | |
| `qq_get_group_file_url` | Get download URL for a group file | |
| `qq_create_group_file_folder` | Create a folder in group files | Yes |
| `qq_delete_group_file` | Delete a group file | Yes |

### Request Handling

| Tool | Description | Owner Only |
|------|-------------|:----------:|
| `qq_handle_friend_request` | Approve/reject friend requests | Yes |
| `qq_handle_group_request` | Approve/reject group join requests | Yes |

## Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed and running
- [NapCat](https://github.com/NapNeko/NapCatQQ) running with HTTP API enabled
- Node.js 22+

## Installation

**Option 1: Clone from Gitee / GitHub (recommended)**

```bash
cd ~/.openclaw/extensions
# Gitee
git clone https://gitee.com/yc1996/openclaw-napcat.git napcat
# or GitHub
git clone https://github.com/963972635/openclaw-napcat.git napcat
cd napcat && npm install --omit=dev
```

**Option 2: Manual copy**

Copy the repository files into `~/.openclaw/extensions/napcat/`, run `npm install --omit=dev`, then add the path to `plugins.load.paths` in your openclaw config.

> This plugin is not published to npm. For npm installation, use the original author's @hyl_aa/openclaw-napcat (for openclaw 2026.5.x and earlier).

## Configuration

Add to your OpenClaw config (`openclaw config edit`):

```json
{
  "channels": {
    "napcat": {
      "httpApi": "http://127.0.0.1:3000",
      "accessToken": "your-token-here",
      "selfId": "123456789",
      "dmPolicy": "allowlist",
      "allowFrom": ["friend_qq_number"],
      "groupPolicy": "allowlist",
      "groupAllowFrom": ["group_number"]
    }
  }
}
```

### Config Fields

| Field | Description |
|-------|-------------|
| `httpApi` | NapCat OneBot 11 HTTP API address |
| `accessToken` | API auth token (optional) |
| `selfId` | Bot's own QQ number (for @mention detection) |
| `dmPolicy` | DM policy: `allowlist` / `pairing` / `open` / `disabled` |
| `allowFrom` | Allowed QQ numbers for DM |
| `groupPolicy` | Group policy: `allowlist` / `open` / `disabled` |
| `groupAllowFrom` | Allowed QQ numbers in groups |
| `wsMode` | Reverse WS mode: `both` (default) / `gateway` / `standalone` — see below |
| `gatewayPath` | URL path for gateway-path mode (default `/napcat/ws`) |

### Reverse WebSocket Modes & connect.challenge Compatibility (openclaw 2026.9.x)

openclaw 2026.9.x gateways send a mandatory `connect.challenge` handshake to every WebSocket connection landing on the gateway's own WS endpoint. Plain OneBot 11 clients (NapCat) cannot answer it, so such connections always time out.

This plugin registers its own WS route on the gateway via `registerHttpRoute` (plugin routes are dispatched BEFORE the gateway's default WS handler), so NapCat connections to `ws://<openclaw-host>:<gateway-port>/napcat/ws` are handled directly by the plugin — **no connect.challenge, pure OneBot 11 traffic**.

**wsMode values:**

| Value | Behavior |
|------|------|
| `both` (default) | Gateway path + standalone port (18800+account index) run side by side for smooth migration |
| `gateway` | Gateway-path mode only (recommended; solves connect.challenge) |
| `standalone` | Standalone port mode only (legacy behavior; NapCat must target port 18800 directly) |

**NapCat side:** point the reverse WebSocket URL at

```
ws://<openclaw-host>:<gateway-port>/napcat/ws
```

For multiple accounts, distinguish via `?account=<accountId>` or rely on the `x-self-id` header NapCat sends automatically. Auth follows the OneBot 11 standard (`Authorization: Bearer <token>` or `?access_token=<token>`).

### Duplicate-Reply Guard (qq_send_message dedup)

When the agent sends a message via the `qq_send_message` tool within a turn, the end-of-turn normal reply delivery is automatically suppressed — the user no longer receives a duplicate second message (normal conversations are unaffected; a new inbound message resets the state). Look for `reply suppressed` in the logs to observe this mechanism.

### Upgrading from the original plugin

If you were using the original @hyl_aa/openclaw-napcat (openclaw 2026.5.x and earlier):

1. Overwrite the plugin directory, then **fully restart** openclaw (jiti module cache does not hot-replace)
2. Update the NapCat reverse WS URL to the gateway-path address described above
3. If the startup log shows `SessionCanonicalKeyMigrationRequiredError`, stop the gateway and run `openclaw doctor --fix` once to migrate legacy session data
4. No openclaw config changes required (`wsMode` defaults to `both`; both connection modes coexist)

**Important:** Set `tools.profile` to `"full"` in your OpenClaw config, otherwise `qq_*` tools will be filtered out by the default `"coding"` profile.

## Usage Examples

Once configured, just talk to your AI in QQ:

- "Help me like user 3870871935" -- AI calls `qq_like_user`
- "Analyze @someone's signature" -- AI extracts QQ number from @mention, calls `qq_get_user_info`
- "Show group member list" -- AI calls `qq_get_group_member_list`
- "Mute @someone for 10 minutes" -- AI calls `qq_mute_group_member` (owner only)
- "Post a group announcement: meeting tomorrow" -- AI calls `qq_send_group_notice` (owner only)
- "Show me recent group chat history" -- AI calls `qq_get_group_msg_history`
- "Pin this message as essence" -- AI calls `qq_set_essence_msg` (owner only)
- "Read the text in this image" -- AI calls `qq_ocr_image`
- "What files are in the group folder?" -- AI calls `qq_get_group_root_files`

## Voice Messages

When voice STT is enabled (`tools.media.audio.enabled: true`), voice messages are automatically transcribed to text before being sent to the AI model.

## Project Structure

```
.
├── index.ts                 # Plugin entry point
├── package.json
├── openclaw.plugin.json     # Plugin metadata
└── src/
    ├── accounts.ts          # Multi-account resolution
    ├── api.ts               # OneBot 11 HTTP API client
    ├── channel.ts           # Channel plugin definition
    ├── config-schema.ts     # Config JSON Schema + UI hints
    ├── gateway-ws.ts        # Gateway-path WS ingress (connect.challenge compatible)
    ├── monitor.ts           # WebSocket message monitor + STT
    ├── probe.ts             # Connection probe / health check
    ├── reply-guard.ts       # Turn-scoped duplicate-reply guard
    ├── runtime.ts           # Runtime context
    ├── send.ts              # Outbound message sending
    ├── tools.ts             # 45 AI agent tools
    └── types.ts             # TypeScript type definitions
```

## License

MIT (continued from the original author Aliang1337's MIT license)
