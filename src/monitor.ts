import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { execFile } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

// 1. resolveSenderCommandAuthorizationWithRuntime - 使用官方 SDK 逻辑
async function resolveSenderCommandAuthorizationWithRuntime(params: {
  cfg: any;
  rawBody: string;
  isGroup: boolean;
  dmPolicy: string;
  configuredAllowFrom: string[];
  configuredGroupAllowFrom?: string[];
  senderId: string;
  isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
  readAllowFromStore?: () => Promise<string[]>;
  runtime: any;
}): Promise<{ 
  senderAllowedForCommands: boolean; 
  commandAuthorized: boolean;
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
}> {
  // 从 runtime 获取授权计算函数
  const shouldComputeAuth = params.runtime.shouldComputeCommandAuthorized 
    ? params.runtime.shouldComputeCommandAuthorized(params.rawBody, params.cfg)
    : false;
  
  // 读取 store allowFrom（用于 pairing 策略）
  const storeAllowFrom = !params.isGroup && params.dmPolicy !== "allowlist" && 
    (params.dmPolicy !== "open" || shouldComputeAuth)
    ? await (params.readAllowFromStore?.() ?? Promise.resolve([]))
    : [];
  
  // 合并 allowFrom 列表
  const effectiveAllowFrom = params.configuredAllowFrom;
  const effectiveGroupAllowFrom = params.configuredGroupAllowFrom ?? [];
  
  // 判断 sender 是否被允许
  const senderAllowedForCommands = params.isSenderAllowed(
    params.senderId,
    params.isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom
  );
  
  // 计算 commandAuthorized
  const commandAuthorized = shouldComputeAuth && params.runtime.resolveCommandAuthorizedFromAuthorizers
    ? params.runtime.resolveCommandAuthorizedFromAuthorizers({
        senderId: params.senderId,
        isGroup: params.isGroup,
      })
    : true;
  
  return {
    senderAllowedForCommands,
    commandAuthorized,
    effectiveAllowFrom,
    effectiveGroupAllowFrom,
  };
}

// 2. resolveDirectDmAuthorizationOutcome - 使用官方 SDK 逻辑
function resolveDirectDmAuthorizationOutcome(params: {
  isGroup: boolean;
  dmPolicy: string;
  senderAllowedForCommands: boolean;
}): "allowed" | "disabled" | "unauthorized" {
  if (params.isGroup) return "allowed";
  if (params.dmPolicy === "disabled") return "disabled";
  if (params.dmPolicy !== "open" && !params.senderAllowedForCommands) return "unauthorized";
  return "allowed";
}

// 3. resolveInboundRouteEnvelopeBuilderWithRuntime - 使用官方 SDK 逻辑
function resolveInboundRouteEnvelopeBuilderWithRuntime(params: {
  cfg: any;
  channel: string;
  accountId: string;
  peer: { kind: string; id: string };
  runtime: any;
  sessionStore?: any;
}): {
  route: { sessionKey: string; accountId: string; agentId?: string };
  buildEnvelope: (envelope: any) => { storePath: string; body: any };
} {
  // 2026.9.x: 用官方 buildAgentSessionKey 构造规范 key（agent:<agentId>:...），
  // 替代旧的内联拼接 `${channel}:${peer.id}`（会触发 canonical key 拒写）。
  const sessionKey = buildAgentSessionKey({
    agentId: "main",
    mainKey: params.cfg?.session?.mainKey,
    channel: params.channel,
    accountId: params.accountId,
    peer: {
      kind: params.peer.kind === "group" ? "group" : "direct",
      id: params.peer.id,
    },
    dmScope: params.cfg?.session?.dmScope,
    groupScope: params.cfg?.session?.groupScope,
  });
  const agentId = "main";
  
  // 使用 runtime 中的 resolveStorePath 计算 storePath
  const storePath = params.runtime.session.resolveStorePath(
    params.sessionStore,
    { agentId }
  );
  
  return {
    route: { sessionKey, accountId: params.accountId, agentId },
    buildEnvelope: (envelope: any) => {
      // 读取上次会话更新时间
      const previousTimestamp = params.runtime.session.readSessionUpdatedAt({
        storePath,
        sessionKey,
      });
      
      // 解析信封格式选项
      const envelopeOptions = params.runtime.reply.resolveEnvelopeFormatOptions(params.cfg);
      
      // 格式化代理信封
      const body = params.runtime.reply.formatAgentEnvelope({
        channel: envelope.channel,
        from: envelope.from,
        timestamp: envelope.timestamp,
        previousTimestamp,
        envelope: envelopeOptions,
        body: envelope.body,
      });
      
      return { storePath, body };
    },
  };
}

// 4. createReplyPrefixOptions - 使用官方 SDK 逻辑
function createReplyPrefixOptions(params: {
  cfg: any;
  channel: string;
  accountId: string;
  agentId?: string;
}): {
  responsePrefix?: string;
  enableSlackInteractiveReplies?: boolean;
  responsePrefixContextProvider?: any;
  onModelSelected?: (ctx: { provider: string; model: string; thinkLevel: string | undefined }) => void;
} {
  // 从配置读取 responsePrefix
  const responsePrefix = params.cfg.channels?.[params.channel as keyof typeof params.cfg.channels]
    ?.accounts?.[params.accountId]?.responsePrefix ??
    params.cfg.channels?.[params.channel as keyof typeof params.cfg.channels]?.responsePrefix;
  
  return {
    responsePrefix,
    enableSlackInteractiveReplies: false,
  };
}

// 5. createTypingCallbacks - 使用官方 SDK 逻辑
function createTypingCallbacks(params: {
  start: () => Promise<void>;
  stop?: () => Promise<void>;
  onStartError: (err: unknown) => void;
  onStopError?: (err: unknown) => void;
  keepaliveIntervalMs?: number;
  maxConsecutiveFailures?: number;
  maxDurationMs?: number;
}): {
  onReplyStart: () => Promise<void>;
  onIdle?: () => void;
  onCleanup?: () => void;
} {
  const keepaliveIntervalMs = params.keepaliveIntervalMs ?? 3000;
  const maxConsecutiveFailures = Math.max(1, params.maxConsecutiveFailures ?? 2);
  const maxDurationMs = params.maxDurationMs ?? 60000;
  let stopSent = false;
  let closed = false;
  let ttlTimer: ReturnType<typeof setTimeout> | undefined;
  let consecutiveFailures = 0;
  let keepaliveTimer: ReturnType<typeof setTimeout> | undefined;
  
  const clearTtlTimer = () => {
    if (ttlTimer) {
      clearTimeout(ttlTimer);
      ttlTimer = undefined;
    }
  };
  
  const clearKeepaliveTimer = () => {
    if (keepaliveTimer) {
      clearTimeout(keepaliveTimer);
      keepaliveTimer = undefined;
    }
  };
  
  const fireStart = async () => {
    try {
      await params.start();
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      params.onStartError(err);
      if (consecutiveFailures >= maxConsecutiveFailures) {
        clearKeepaliveTimer();
      }
    }
  };
  
  const startKeepalive = () => {
    clearKeepaliveTimer();
    keepaliveTimer = setTimeout(() => {
      if (!closed && !stopSent) {
        fireStart();
        if (!closed && !stopSent) {
          startKeepalive();
        }
      }
    }, keepaliveIntervalMs);
  };
  
  const startTtlTimer = () => {
    if (maxDurationMs <= 0) return;
    clearTtlTimer();
    ttlTimer = setTimeout(() => {
      clearKeepaliveTimer();
      if (params.stop && !stopSent) {
        stopSent = true;
        params.stop().catch((err) => params.onStopError?.(err));
      }
    }, maxDurationMs);
  };
  
  return {
    onReplyStart: async () => {
      if (closed) return;
      await fireStart();
      startKeepalive();
      startTtlTimer();
    },
    onIdle: () => {
      clearKeepaliveTimer();
      if (params.stop && !stopSent) {
        stopSent = true;
        params.stop().catch((err) => params.onStopError?.(err));
      }
    },
    onCleanup: () => {
      closed = true;
      clearTtlTimer();
      clearKeepaliveTimer();
    },
  };
}

// 6. resolveOutboundMediaUrls - 使用官方 SDK 逻辑
function resolveOutboundMediaUrls(payload: { 
  text?: string; 
  mediaUrls?: string[]; 
  mediaUrl?: string; 
}): string[] {
  if (payload.mediaUrls?.length) return payload.mediaUrls;
  if (payload.mediaUrl) return [payload.mediaUrl];
  return [];
}

// 7. resolveDefaultGroupPolicy - 使用官方 SDK 逻辑
function resolveDefaultGroupPolicy(cfg: any): string {
  return cfg.channels?.defaults?.groupPolicy ?? "open";
}

// 8. waitUntilAbort
function waitUntilAbort(signal?: AbortSignal, onAbort?: () => void): Promise<void> {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => {
      onAbort?.();
      resolve();
    }, { once: true });
  });
}


// createScopedPairingAccess is not available from a public SDK subpath;
// inline a thin wrapper over core.channel.pairing methods.
function createScopedPairingAccess(params: {
  core: ReturnType<typeof getNapCatRuntime>;
  channel: string;
  accountId: string;
}) {
  const { core, channel, accountId } = params;
  const pairing = (core.channel as Record<string, unknown>).pairing as {
    readAllowFromStore: (p: { channel: string; accountId: string }) => Promise<string[]>;
    upsertPairingRequest: (p: { id: string; channel: string; accountId: string; meta?: Record<string, string | undefined> }) => Promise<{ code: string; created: boolean }>;
  };
  return {
    accountId,
    readAllowFromStore: () => pairing.readAllowFromStore({ channel, accountId }),
    readStoreForDmPolicy: (provider: string, acctId: string) =>
      pairing.readAllowFromStore({ channel: provider, accountId: acctId }),
    upsertPairingRequest: (input: { id: string; meta?: Record<string, string | undefined> }) =>
      pairing.upsertPairingRequest({ ...input, channel, accountId }),
  };
}

// issuePairingChallenge is not available from a public SDK subpath;
// inline the standard create-if-missing + reply flow.
async function issuePairingChallenge(params: {
  channel: string;
  senderId: string;
  senderIdLine: string;
  meta?: Record<string, string | undefined>;
  upsertPairingRequest: (input: { id: string; meta?: Record<string, string | undefined> }) => Promise<{ code: string; created: boolean }>;
  sendPairingReply: (text: string) => Promise<void>;
  onCreated?: (params: { code: string }) => void;
  onReplyError?: (err: unknown) => void;
}): Promise<{ created: boolean; code?: string }> {
  const { code, created } = await params.upsertPairingRequest({
    id: params.senderId,
    meta: params.meta,
  });
  if (created) params.onCreated?.({ code });
  const replyText = `To pair, run this command in your terminal:\n\nopenclaw allow ${params.channel}:${params.senderId}\n\n${params.senderIdLine}\nPairing code: ${code}`;
  try {
    await params.sendPairingReply(replyText);
  } catch (err) {
    params.onReplyError?.(err);
  }
  return { created, code };
}
import type { ResolvedNapCatAccount } from "./types.js";
import type { OneBotMessageEvent, OneBotSegment } from "./types.js";
import { sendGroupMsg, sendPrivateMsg, textSegment, replySegment, recordSegment, videoSegment, uploadGroupFile, uploadPrivateFile, getMsg } from "./api.js";
import { getNapCatRuntime } from "./runtime.js";
// 2026.9.x: 规范化 session key 必须由官方 buildAgentSessionKey 构造
// （agent:<agentId>:<channel>:... 格式），内联拼接 channel:peerId 会触发
// SessionCanonicalKeyMigrationRequiredError 拒写。
import { buildAgentSessionKey } from "openclaw/plugin-sdk/core";
// 回合内 qq_send_message 已回复的会话标记（防双发）
import { clearToolSent, clearToolSentMessage, wasToolSent } from "./reply-guard.js";

export type NapCatRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type NapCatMonitorOptions = {
  account: ResolvedNapCatAccount;
  config: OpenClawConfig;
  runtime: NapCatRuntimeEnv;
  abortSignal: AbortSignal;
  /** Port for the reverse WS server that NapCat connects to. */
  wsPort: number;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

type NapCatCoreRuntime = ReturnType<typeof getNapCatRuntime>;

const QQ_TEXT_LIMIT = 4500;

/** Extract the reply message ID from segments (if any). */
function extractReplyMessageId(segments: OneBotSegment[]): number | undefined {
  const reply = segments.find((s) => s.type === "reply");
  if (!reply?.data.id) return undefined;
  const id = Number(reply.data.id);
  return Number.isFinite(id) ? id : undefined;
}

/** Fetch the quoted message text via get_msg API. Returns formatted quote or undefined. */
async function fetchQuotedMessageText(
  httpApi: string,
  messageId: number,
  accessToken?: string,
): Promise<string | undefined> {
  try {
    const msg = await getMsg(httpApi, messageId, accessToken);
    const senderName =
      (msg.sender.card as string) || (msg.sender.nickname as string) || String(msg.sender.user_id ?? "unknown");
    // Extract text from the quoted message segments
    const quotedText = msg.message
      .map((s) => {
        if (s.type === "text") return s.data.text ?? "";
        if (s.type === "at") return `@${s.data.qq}`;
        if (s.type === "image") return "[图片]";
        if (s.type === "face") return "[表情]";
        if (s.type === "record") return "[语音]";
        if (s.type === "video") return "[视频]";
        if (s.type === "file") return "[文件]";
        return "";
      })
      .join("")
      .trim();
    if (!quotedText) return undefined;
    return `[引用 ${senderName} 的消息: ${quotedText}]`;
  } catch {
    return undefined;
  }
}

/** Extract plain text from OneBot message segments, converting @mentions to readable form. */
function extractText(segments: OneBotSegment[]): string {
  return segments
    .map((s) => {
      if (s.type === "text") return s.data.text ?? "";
      if (s.type === "at") return `@${s.data.qq}`;
      return "";
    })
    .join("")
    .trim();
}

/** Extract image URLs from OneBot message segments. */
function extractImageUrls(segments: OneBotSegment[]): string[] {
  return segments
    .filter((s) => s.type === "image")
    .map((s) => s.data.url ?? s.data.file ?? "")
    .filter(Boolean);
}

/** Extract voice/record URL from OneBot message segments. */
function extractRecordUrl(segments: OneBotSegment[]): string | undefined {
  const record = segments.find((s) => s.type === "record");
  if (!record) return undefined;
  return record.data.url ?? record.data.file ?? undefined;
}

/** Classify outbound media by file extension. */
type MediaKind = "image" | "audio" | "video" | "file";
const AUDIO_EXTENSIONS = new Set([".mp3", ".opus", ".ogg", ".wav", ".flac", ".m4a", ".aac", ".silk", ".amr"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".avi", ".mkv", ".mov", ".webm", ".flv", ".wmv"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".ico", ".svg"]);

function getFileExtension(url: string): string {
  const pathname = url.includes("?") ? url.slice(0, url.indexOf("?")) : url;
  const dot = pathname.lastIndexOf(".");
  if (dot === -1) return "";
  return pathname.slice(dot).toLowerCase();
}

function classifyMediaUrl(url: string): MediaKind {
  const ext = getFileExtension(url);
  if (!ext) return "image"; // fallback for extensionless URLs
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "file"; // pdf, doc, zip, etc.
}

/** Extract the file name from a URL/path. */
function extractFileName(url: string): string {
  const pathname = url.includes("?") ? url.slice(0, url.indexOf("?")) : url;
  const slash = pathname.lastIndexOf("/");
  return slash === -1 ? pathname : pathname.slice(slash + 1);
}

/** Download a URL and convert to wav using ffmpeg. Returns the wav file path. */
async function downloadAndConvertToWav(
  url: string,
  fetcher: (params: { url: string; maxBytes: number }) => Promise<{ buffer: Buffer; contentType: string }>,
  maxBytes: number,
): Promise<string | undefined> {
  const fetched = await fetcher({ url, maxBytes });
  const ts = Date.now();
  const inputPath = join(tmpdir(), `napcat-voice-${ts}.silk`);
  const outputPath = join(tmpdir(), `napcat-voice-${ts}.wav`);

  await writeFile(inputPath, fetched.buffer);

  return new Promise<string | undefined>((resolve) => {
    execFile(
      "ffmpeg",
      ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-f", "wav", outputPath],
      { timeout: 15_000 },
      async (err) => {
        // Clean up input file
        await unlink(inputPath).catch(() => {});
        if (err) {
          await unlink(outputPath).catch(() => {});
          resolve(undefined);
        } else {
          resolve(outputPath);
        }
      },
    );
  });
}

/** Check if the message contains an @bot mention. */
function hasBotMention(segments: OneBotSegment[], selfId: string): boolean {
  return segments.some(
    (s) => s.type === "at" && s.data.qq === selfId,
  );
}

/** Strip @bot mention segments and leading whitespace from text. */
function stripBotMention(segments: OneBotSegment[], selfId: string): OneBotSegment[] {
  return segments.filter(
    (s) => !(s.type === "at" && s.data.qq === selfId),
  );
}

/** Determine if sender is allowed based on allowlist. */
function isNapCatSenderAllowed(
  senderId: string,
  allowFrom: Array<string | number>,
): boolean {
  return allowFrom.some((entry) => String(entry) === senderId);
}

/**
 * Shared per-connection handler for NapCat reverse WebSocket connections.
 * Used by both the standalone-port server and the gateway-path upgrade handler.
 */
export function handleNapCatConnection(params: {
  ws: WebSocket;
  req: IncomingMessage;
  account: ResolvedNapCatAccount;
  config: OpenClawConfig;
  runtime: NapCatRuntimeEnv;
  core: NapCatCoreRuntime;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): () => void {
  const { ws, req, account, config, runtime, core, statusSink } = params;
  const selfId = req.headers["x-self-id"];
  runtime.log?.(`[${account.accountId}] NapCat connected, self_id=${selfId ?? "unknown"}`);

  ws.on("message", (raw: Buffer) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      runtime.error?.(`[${account.accountId}] NapCat: invalid JSON from WS`);
      return;
    }

    // Ignore meta events (heartbeat, lifecycle)
    if (data.post_type === "meta_event") return;

    // Only handle message events
    if (data.post_type !== "message") return;

    const event = data as unknown as OneBotMessageEvent;
    processMessage(event, account, config, runtime, core, statusSink).catch((err) => {
      runtime.error?.(`[${account.accountId}] NapCat message processing error: ${String(err)}`);
    });
  });

  ws.on("close", () => {
    runtime.log?.(`[${account.accountId}] NapCat WS disconnected`);
  });

  ws.on("error", (err: Error) => {
    runtime.error?.(`[${account.accountId}] NapCat WS error: ${String(err)}`);
  });

  // Return a no-op disposer; per-connection state is stateless here.
  return () => {};
}

/**
 * Start a reverse WebSocket server for NapCat to connect to.
 * NapCat will initiate the connection to this server (standalone port mode).
 */
export async function monitorNapCatProvider(options: NapCatMonitorOptions): Promise<void> {
  const { account, config, runtime, abortSignal, wsPort, statusSink } = options;
  const core = getNapCatRuntime();

  runtime.log?.(`[${account.accountId}] NapCat starting reverse WS server on port ${wsPort}`);

  const server = createServer();
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    handleNapCatConnection({
      ws,
      req,
      account,
      config,
      runtime,
      core,
      statusSink,
    });
  });

  return new Promise<void>((resolve, reject) => {
    server.listen(wsPort, "0.0.0.0", () => {
      runtime.log?.(`[${account.accountId}] NapCat reverse WS server listening on ws://0.0.0.0:${wsPort}`);
    });

    server.on("error", (err) => {
      runtime.error?.(`[${account.accountId}] NapCat WS server error: ${String(err)}`);
      reject(err);
    });

    // Cleanup on abort
    const onAbort = () => {
      runtime.log?.(`[${account.accountId}] NapCat stopping WS server`);
      wss.clients.forEach((client: import("ws").WebSocket) => client.close());
      wss.close();
      server.close();
      resolve();
    };

    if (abortSignal.aborted) {
      onAbort();
      return;
    }
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

async function processMessage(
  event: OneBotMessageEvent,
  account: ResolvedNapCatAccount,
  config: OpenClawConfig,
  runtime: NapCatRuntimeEnv,
  core: NapCatCoreRuntime,
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void,
): Promise<void> {
  const isGroup = event.message_type === "group";
  const senderId = String(event.user_id);
  const senderName = event.sender.card || event.sender.nickname;
  const chatId = isGroup ? String(event.group_id) : senderId;
  const selfId = account.selfId || String(event.self_id);

  // New inbound turn begins — clear any tool-send marker for this chat so
  // this turn's end-of-turn reply is delivered normally (unless the agent
  // replies via qq_send_message again during this turn).
  clearToolSent(isGroup ? "group" : "private", chatId);
  // C2: also clear the qq_send_message per-turn marker so each NEW turn may
  // send once (the block only forbids a second send within the same turn).
  clearToolSentMessage(isGroup ? "group" : "private", chatId);

  // In group chats, require @bot mention
  if (isGroup && !hasBotMention(event.message, selfId)) {
    return;
  }

  // Strip @bot mention from message for processing
  const cleanSegments = isGroup
    ? stripBotMention(event.message, selfId)
    : event.message;

  let text = extractText(cleanSegments);
  const imageUrls = extractImageUrls(cleanSegments);
  const recordUrl = extractRecordUrl(cleanSegments);

  // Fetch quoted message content if this is a reply
  const replyMsgId = extractReplyMessageId(event.message);
  if (replyMsgId) {
    const quotedText = await fetchQuotedMessageText(
      account.httpApi,
      replyMsgId,
      account.accessToken,
    );
    if (quotedText) {
      text = quotedText + "\n" + text;
    }
  }

  // Skip empty messages
  if (!text && imageUrls.length === 0 && !recordUrl) return;

  // Will be set if voice STT succeeds.
  let voiceTranscript: string | undefined;

  statusSink?.({ lastInboundAt: Date.now() });

  // Download first image if present
  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  if (imageUrls.length > 0) {
    try {
      const mediaMaxMb = account.config.mediaMaxMb ?? 5;
      const maxBytes = mediaMaxMb * 1024 * 1024;
      const fetched = await core.channel.media.fetchRemoteMedia({
        url: imageUrls[0],
        maxBytes,
      });
      const saved = await core.channel.media.saveMediaBuffer(
        fetched.buffer,
        fetched.contentType,
        "inbound",
        maxBytes,
      );
      mediaPath = saved.path;
      mediaType = saved.contentType;
    } catch (err) {
      runtime.error?.(`[${account.accountId}] Failed to download QQ image: ${String(err)}`);
    }
  } else if (recordUrl) {
    // Voice message: download → ffmpeg wav → STT transcribe → text
    try {
      const mediaMaxMb = account.config.mediaMaxMb ?? 5;
      const maxBytes = mediaMaxMb * 1024 * 1024;
      const wavPath = await downloadAndConvertToWav(
        recordUrl,
        // 2026.9.x: fetchRemoteMedia 返回 FetchMediaResult（contentType 可选），适配本地 fetcher 签名
        (async (options: { url: string; maxBytes: number }) => {
          const fetched = await core.channel.media.fetchRemoteMedia(options);
          return {
            buffer: Buffer.from(fetched.buffer),
            contentType: fetched.contentType ?? "application/octet-stream",
          };
        }),
        maxBytes,
      );
      if (wavPath) {
        try {
          const result = await core.mediaUnderstanding.transcribeAudioFile({
            filePath: wavPath,
            cfg: config,
            mime: "audio/wav",
          });
          if (result.text) {
            // Transcription succeeded — use text instead of raw audio.
            voiceTranscript = result.text;
            await unlink(wavPath).catch(() => {});
            runtime.log?.(`[${account.accountId}] Voice transcribed: ${result.text.slice(0, 80)}`);
          } else {
            // STT returned empty; fall back to passing audio file.
            mediaPath = wavPath;
            mediaType = "audio/wav";
          }
        } catch (sttErr) {
          runtime.error?.(`[${account.accountId}] STT failed, falling back to audio: ${String(sttErr)}`);
          mediaPath = wavPath;
          mediaType = "audio/wav";
        }
      } else {
        runtime.error?.(`[${account.accountId}] ffmpeg voice conversion failed`);
      }
    } catch (err) {
      runtime.error?.(`[${account.accountId}] Failed to process QQ voice: ${String(err)}`);
    }
  }

  // Authorization pipeline
  const pairing = createScopedPairingAccess({
    core,
    channel: "napcat",
    accountId: account.accountId,
  });

  const dmPolicy = account.config.dmPolicy ?? "allowlist";
  const configAllowFrom = (account.config.allowFrom ?? []).map((v) => String(v));
  const configuredGroupAllowFrom = (account.config.groupAllowFrom ?? []).map((v) => String(v));
  const groupAllowFrom =
    configuredGroupAllowFrom.length > 0 ? configuredGroupAllowFrom : configAllowFrom;

  // Group access control
  if (isGroup) {
    const groupPolicy = account.config.groupPolicy ?? resolveDefaultGroupPolicy(config);
    if (groupPolicy === "disabled") {
      return;
    }
    if (groupPolicy === "allowlist") {
      if (!isNapCatSenderAllowed(senderId, groupAllowFrom)) {
        return;
      }
    }
  }

  // Merge voice transcript into message body when available.
  const effectiveText = voiceTranscript
    ? (text ? `${text}\n[语音转文字] ${voiceTranscript}` : `[语音转文字] ${voiceTranscript}`)
    : text;
  const rawBody = effectiveText || (mediaPath ? "<media:image>" : "");
  const { senderAllowedForCommands, commandAuthorized } =
    await resolveSenderCommandAuthorizationWithRuntime({
      cfg: config,
      rawBody,
      isGroup,
      dmPolicy,
      configuredAllowFrom: configAllowFrom,
      configuredGroupAllowFrom: groupAllowFrom,
      senderId,
      isSenderAllowed: isNapCatSenderAllowed,
      readAllowFromStore: pairing.readAllowFromStore,
      runtime: core.channel.commands,
    });

  // DM authorization
  const directDmOutcome = resolveDirectDmAuthorizationOutcome({
    isGroup,
    dmPolicy,
    senderAllowedForCommands,
  });
  if (directDmOutcome === "disabled") return;
  if (directDmOutcome === "unauthorized") {
    if (dmPolicy === "pairing") {
      await issuePairingChallenge({
        channel: "napcat",
        senderId,
        senderIdLine: `Your QQ number: ${senderId}`,
        meta: { name: senderName ?? undefined },
        upsertPairingRequest: pairing.upsertPairingRequest,
        onCreated: () => {
          runtime.log?.(`[${account.accountId}] napcat pairing request sender=${senderId}`);
        },
        sendPairingReply: async (replyText) => {
          try {
            await sendPrivateMsg(
              account.httpApi,
              Number(senderId),
              [textSegment(replyText)],
              account.accessToken,
            );
            statusSink?.({ lastOutboundAt: Date.now() });
          } catch (err) {
            runtime.error?.(`[${account.accountId}] pairing reply failed: ${String(err)}`);
          }
        },
        onReplyError: (err) => {
          runtime.error?.(`[${account.accountId}] pairing reply error: ${String(err)}`);
        },
      });
    }
    return;
  }

  // Route resolution — group sessions are per-user so each sender has isolated context.
  const fromLabel = isGroup ? `group:${chatId}` : senderName || `user:${senderId}`;
  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: config,
    channel: "napcat",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      // id: isGroup ? `${chatId}:${senderId}` : chatId, -- 群聊内每个成员创建单独会话防止个人隐私问题泄露，不明所以的设计（YC 2026-06-12注掉）
      id: isGroup ? chatId : chatId,
    },
    runtime: core.channel,
    sessionStore: config.session?.store,
  });

  // Block unauthorized control commands in groups
  if (
    isGroup &&
    core.channel.commands.isControlCommandMessage(rawBody, config) &&
    commandAuthorized !== true
  ) {
    return;
  }

  const { storePath, body } = buildEnvelope({
    channel: "QQ",
    from: fromLabel,
    timestamp: event.time ? event.time * 1000 : undefined,
    body: rawBody,
  });

  const targetPrefix = isGroup ? `napcat:group:${chatId}` : `napcat:${senderId}`;
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: targetPrefix,
    To: isGroup ? `napcat:group:${chatId}` : `napcat:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    CommandAuthorized: commandAuthorized,
    Provider: "napcat",
    Surface: "napcat",
    MessageSid: String(event.message_id),
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath,
    OriginatingChannel: "napcat",
    OriginatingTo: isGroup ? `napcat:group:${chatId}` : `napcat:${chatId}`,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`napcat: failed updating session meta: ${String(err)}`);
    },
  });

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: config,
    channel: "napcat",
    accountId: account.accountId,
  }) as "off" | "bullets" | "code" | "block";

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: "napcat",
    accountId: account.accountId,
  });

  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      // QQ doesn't have a "typing" indicator via OneBot, no-op
    },
    onStartError: () => {},
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...prefixOptions,
      typingCallbacks,
      deliver: async (payload) => {
        // Suppress the normal end-of-turn reply when qq_send_message already
        // delivered to this chat during the current turn (duplicate guard).
        if (wasToolSent(isGroup ? "group" : "private", chatId)) {
          runtime.log?.(
            `[${account.accountId}] reply suppressed: qq_send_message already replied to ${isGroup ? "group" : "private"}:${chatId} this turn`,
          );
          return;
        }
        await deliverNapCatReply({
          payload,
          account,
          chatId,
          isGroup,
          runtime,
          core,
          config,
          statusSink,
          tableMode,
          replyToMessageId: event.message_id,
        });
      },
      onError: (err, info) => {
        runtime.error?.(`[${account.accountId}] NapCat ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      onModelSelected,
    },
  });
}

async function deliverNapCatReply(params: {
  payload: { text?: string; mediaUrls?: string[] };
  account: ResolvedNapCatAccount;
  chatId: string;
  isGroup: boolean;
  runtime: NapCatRuntimeEnv;
  core: NapCatCoreRuntime;
  config: OpenClawConfig;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  /** Markdown 表格转换模式（2026.9.x: MarkdownTableMode 联合类型）。 */
  tableMode?: "off" | "bullets" | "code" | "block";
  /** Original message ID to quote-reply in group chats. */
  replyToMessageId?: number;
}): Promise<void> {
  const { payload, account, chatId, isGroup, runtime, core, config, statusSink } = params;
  const tableMode = params.tableMode ?? "code";
  const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
  const mediaUrls = resolveOutboundMediaUrls(payload);

  // In group chats, prepend a reply segment to quote the original message.
  const replyPrefix: OneBotSegment[] =
    isGroup && params.replyToMessageId
      ? [replySegment(params.replyToMessageId)]
      : [];

  // Classify outbound media into categories for QQ delivery.
  const imageSegments: OneBotSegment[] = [];
  const audioSegments: OneBotSegment[] = [];
  const videoSegments: OneBotSegment[] = [];
  const fileUrls: string[] = [];
  for (const url of mediaUrls) {
    const kind = classifyMediaUrl(url);
    if (kind === "audio") {
      audioSegments.push(recordSegment(url));
    } else if (kind === "video") {
      videoSegments.push(videoSegment(url));
    } else if (kind === "file") {
      fileUrls.push(url);
    } else {
      imageSegments.push({ type: "image", data: { file: url } });
    }
  }

  // Helper: send a message via group or private.
  const send = async (segments: OneBotSegment[]) => {
    if (isGroup) {
      await sendGroupMsg(account.httpApi, Number(chatId), segments, account.accessToken);
    } else {
      await sendPrivateMsg(account.httpApi, Number(chatId), segments, account.accessToken);
    }
    statusSink?.({ lastOutboundAt: Date.now() });
  };

  // Add text (chunked if needed)
  if (text) {
    const chunkMode = core.channel.text.resolveChunkMode(config, "napcat", account.accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(text, QQ_TEXT_LIMIT, chunkMode);
    for (let i = 0; i < chunks.length; i++) {
      // First chunk gets reply-quote + images; subsequent chunks are plain text.
      const toSend =
        i === 0
          ? [...replyPrefix, ...imageSegments, textSegment(chunks[i])]
          : [textSegment(chunks[i])];

      try {
        await send(toSend);
      } catch (err) {
        runtime.error?.(`NapCat message send failed: ${String(err)}`);
      }
    }
  } else if (imageSegments.length > 0) {
    // Image only, no text — still quote the original message.
    try {
      await send([...replyPrefix, ...imageSegments]);
    } catch (err) {
      runtime.error?.(`NapCat image send failed: ${String(err)}`);
    }
  }

  // Voice segments must be sent separately (QQ record segments cannot mix with text/image).
  for (const seg of audioSegments) {
    try {
      await send([seg]);
    } catch (err) {
      runtime.error?.(`NapCat voice send failed: ${String(err)}`);
    }
  }

  // Video segments must also be sent individually.
  for (const seg of videoSegments) {
    try {
      await send([seg]);
    } catch (err) {
      runtime.error?.(`NapCat video send failed: ${String(err)}`);
    }
  }

  // Files (pdf, doc, zip, etc.) use the upload_file API (NapCat extension).
  for (const url of fileUrls) {
    const name = extractFileName(url);
    try {
      if (isGroup) {
        await uploadGroupFile(account.httpApi, Number(chatId), url, name, account.accessToken);
      } else {
        await uploadPrivateFile(account.httpApi, Number(chatId), url, name, account.accessToken);
      }
      statusSink?.({ lastOutboundAt: Date.now() });
    } catch (err) {
      runtime.error?.(`NapCat file upload failed: ${String(err)}`);
    }
  }
}
