import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId
} from "openclaw/plugin-sdk/account-id";

// 账号配置相关（channel-plugin-common）
import {
  applyAccountNameToChannelSection,
  deleteAccountFromConfigSection,
  migrateBaseNameToDefaultAccount,
  setAccountEnabledInConfigSection,
  PAIRING_APPROVED_MESSAGE,
} from "openclaw/plugin-sdk/channel-plugin-common";

// DM 安全策略 + allowFrom 映射（channel-config-helpers）
import {
  buildAccountScopedDmSecurityPolicy,
  mapAllowFromEntries,
} from "openclaw/plugin-sdk/channel-config-helpers";

// Group Policy 警告（channel-policy）
import {
  collectOpenProviderGroupPolicyWarnings,
  buildOpenGroupPolicyRestrictSendersWarning,
  buildOpenGroupPolicyWarning,
} from "openclaw/plugin-sdk/channel-policy";

// Setup 向导配置补丁（setup）
import {
  applySetupAccountConfigPatch,
} from "openclaw/plugin-sdk/setup";

// 账号状态 sink（channel-lifecycle）
import {
  createAccountStatusSink,
} from "openclaw/plugin-sdk/channel-lifecycle";

// allowFrom 小写格式化（allow-from）
import {
  formatAllowFromLowercase,
} from "openclaw/plugin-sdk/allow-from";

// 出站 payload 分块发送 + 数字目标 ID 判定（reply-payload）
import {
  isNumericTargetId,
  sendPayloadWithChunkedTextAndMedia,
} from "openclaw/plugin-sdk/reply-payload";

// 目录条目列表（directory-runtime）
import {
  listDirectoryUserEntriesFromAllowFrom,
} from "openclaw/plugin-sdk/directory-runtime";

// 状态快照相关（status-helpers）
import {
  buildBaseAccountStatusSnapshot,
} from "openclaw/plugin-sdk/status-helpers";

// 发送结果相关（channel-send-result）
import {
  buildChannelSendResult,
} from "openclaw/plugin-sdk/channel-send-result";


// 内联函数 - 使用官方 SDK 逻辑
function buildBaseChannelStatusSummary(
  snapshot: {
    configured?: boolean | null;
    running?: boolean | null;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastError?: string | null;
  }
): {
  configured: boolean;
  running: boolean;
  lastStartAt: number | null;
  lastStopAt: number | null;
  lastError: string | null;
} {
  return {
    configured: snapshot.configured ?? false,
    running: snapshot.running ?? false,
    lastStartAt: snapshot.lastStartAt ?? null,
    lastStopAt: snapshot.lastStopAt ?? null,
    lastError: snapshot.lastError ?? null,
  };
}

function buildTokenChannelStatusSummary(
  snapshot: {
    configured?: boolean | null;
    tokenSource?: string | null;
    running?: boolean | null;
    mode?: string | null;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastError?: string | null;
    probe?: unknown;
    lastProbeAt?: number | null;
  },
  opts?: { includeMode?: boolean }
): {
  tokenSource: string;
  probe: unknown;
  lastProbeAt: number | null;
  configured: boolean;
  running: boolean;
  lastStartAt: number | null;
  lastStopAt: number | null;
  lastError: string | null;
  mode?: string | null;
} {
  const base = {
    ...buildBaseChannelStatusSummary(snapshot),
    tokenSource: snapshot.tokenSource ?? "none",
    probe: snapshot.probe ?? null,
    lastProbeAt: snapshot.lastProbeAt ?? null,
  };
  if (opts?.includeMode === false) return base;
  return {
    ...base,
    mode: snapshot.mode ?? null,
  };
}

// chunkTextForOutbound - 使用官方 SDK 逻辑
function chunkTextByBreakResolver(
  text: string,
  limit: number,
  resolveBreakIndex: (window: string) => number
): string[] {
  if (!text) return [];
  if (limit <= 0 || text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const candidateBreak = resolveBreakIndex(remaining.slice(0, limit));
    const breakIdx =
      Number.isFinite(candidateBreak) && candidateBreak > 0 && candidateBreak <= limit
        ? candidateBreak
        : limit;
    const chunk = remaining.slice(0, breakIdx).trimEnd();
    if (chunk.length > 0) chunks.push(chunk);
    const brokeOnSeparator = breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
    const nextStart = Math.min(remaining.length, breakIdx + (brokeOnSeparator ? 1 : 0));
    remaining = remaining.slice(nextStart).trimStart();
  }
  if (remaining.length) chunks.push(remaining);
  return chunks;
}

function chunkTextForOutbound(text: string, limit: number): string[] {
  return chunkTextByBreakResolver(text, limit, (window) => {
    const lastNewline = window.lastIndexOf("\n");
    const lastSpace = window.lastIndexOf(" ");
    return lastNewline > 0 ? lastNewline : lastSpace;
  });
}

import {
  listNapCatAccountIds,
  resolveDefaultNapCatAccountId,
  resolveNapCatAccount,
} from "./accounts.js";
import type { ResolvedNapCatAccount } from "./types.js";
import { NapCatChannelConfigSchema } from "./config-schema.js";
import { createNapCatAgentTools } from "./tools.js";
import { probeNapCat } from "./probe.js";
import { sendMessageNapCat } from "./send.js";
import { sendPrivateMsg, textSegment } from "./api.js";

const meta = {
  id: "napcat" as const,
  label: "QQ (NapCat)",
  selectionLabel: "QQ via NapCat (OneBot 11)",
  docsPath: "/channels/napcat",
  docsLabel: "napcat",
  blurb: "QQ messaging via NapCat OneBot 11 reverse WebSocket.",
  aliases: ["qq", "onebot"],
  order: 90,
  quickstartAllowFrom: true,
};

function normalizeNapCatMessagingTarget(raw: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  // Strip prefixes like "napcat:", "qq:", "onebot:"
  return trimmed.replace(/^(napcat|qq|onebot):/i, "");
}

/** Normalize the wsMode setting; default "both" keeps old standalone behavior while adding the gateway path. */
function resolveWsMode(raw: string | undefined): "gateway" | "standalone" | "both" {
  if (raw === "gateway" || raw === "standalone") return raw;
  return "both";
}

export const napCatPlugin: ChannelPlugin<ResolvedNapCatAccount> = {
  id: "napcat",
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.napcat"] },
  configSchema: NapCatChannelConfigSchema,
  agentTools: ({ cfg }) => (cfg ? createNapCatAgentTools(cfg) : []),
  config: {
    listAccountIds: (cfg) => listNapCatAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveNapCatAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultNapCatAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "napcat",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "napcat",
        accountId,
        clearBaseFields: ["httpApi", "accessToken", "selfId", "name"],
      }),
    isConfigured: (account) => Boolean(account.httpApi?.trim()),
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.httpApi?.trim()),
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      mapAllowFromEntries(resolveNapCatAccount({ cfg, accountId }).config.allowFrom),
    formatAllowFrom: ({ allowFrom }) =>
      formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(napcat|qq|onebot):/i }),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      return buildAccountScopedDmSecurityPolicy({
        cfg,
        channelKey: "napcat",
        accountId,
        fallbackAccountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
        policy: account.config.dmPolicy,
        allowFrom: account.config.allowFrom ?? [],
        policyPathSuffix: "dmPolicy",
        normalizeEntry: (raw) => raw.replace(/^(napcat|qq|onebot):/i, ""),
      });
    },
    collectWarnings: ({ account, cfg }) => {
      return collectOpenProviderGroupPolicyWarnings({
        cfg,
        // OpenClawConfig.channels 是强类型（不含自定义通道 napcat），经 unknown 中转读取
        providerConfigPresent:
          (cfg as unknown as { channels?: Record<string, unknown> }).channels?.napcat !== undefined,
        configuredGroupPolicy: account.config.groupPolicy,
        collect: (groupPolicy) => {
          if (groupPolicy !== "open") return [];
          const explicitGroupAllowFrom = mapAllowFromEntries(account.config.groupAllowFrom);
          const dmAllowFrom = mapAllowFromEntries(account.config.allowFrom);
          const effectiveAllowFrom =
            explicitGroupAllowFrom.length > 0 ? explicitGroupAllowFrom : dmAllowFrom;
          if (effectiveAllowFrom.length > 0) {
            return [
              buildOpenGroupPolicyRestrictSendersWarning({
                surface: "QQ groups",
                openScope: "any member",
                groupPolicyPath: "channels.napcat.groupPolicy",
                groupAllowFromPath: "channels.napcat.groupAllowFrom",
              }),
            ];
          }
          return [
            buildOpenGroupPolicyWarning({
              surface: "QQ groups",
              openBehavior:
                "with no groupAllowFrom/allowFrom allowlist; any member can trigger (mention-gated)",
              remediation:
                'Set channels.napcat.groupPolicy="allowlist" + channels.napcat.groupAllowFrom',
            }),
          ];
        },
      });
    },
  },
  groups: {
    resolveRequireMention: () => true,
  },
  threading: {
    resolveReplyToMode: () => "off",
  },
  messaging: {
    normalizeTarget: normalizeNapCatMessagingTarget,
    targetResolver: {
      looksLikeId: isNumericTargetId,
      hint: "<qqNumber> or group:<groupId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveNapCatAccount({ cfg, accountId });
      return listDirectoryUserEntriesFromAllowFrom({
        allowFrom: account.config.allowFrom,
        query,
        limit,
        normalizeId: (entry) => entry.replace(/^(napcat|qq|onebot):/i, ""),
      });
    },
    listGroups: async () => [],
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "napcat",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (!input.token && !input.useEnv) {
        return "NapCat requires httpApi URL. Set channels.napcat.httpApi in config.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "napcat",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({ cfg: namedConfig, channelKey: "napcat" })
          : namedConfig;
      const patch = input.token ? { httpApi: input.token } : {};
      return applySetupAccountConfigPatch({
        cfg: next,
        channelKey: "napcat",
        accountId,
        patch,
      });
    },
  },
  pairing: {
    idLabel: "qqNumber",
    normalizeAllowEntry: (entry) => entry.replace(/^(napcat|qq|onebot):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveNapCatAccount({ cfg });
      if (!account.httpApi) {
        throw new Error("NapCat httpApi not configured");
      }
      await sendPrivateMsg(
        account.httpApi,
        Number(id),
        [textSegment(PAIRING_APPROVED_MESSAGE)],
        account.accessToken,
      );
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: chunkTextForOutbound,
    chunkerMode: "text",
    textChunkLimit: 4500,
    sendPayload: async (ctx) =>
      await sendPayloadWithChunkedTextAndMedia({
        ctx,
        textChunkLimit: napCatPlugin.outbound!.textChunkLimit,
        chunker: napCatPlugin.outbound!.chunker,
        sendText: (nextCtx) => napCatPlugin.outbound!.sendText!(nextCtx),
        sendMedia: (nextCtx) => napCatPlugin.outbound!.sendMedia!(nextCtx),
        emptyResult: { channel: "napcat", messageId: "" },
      }),
    sendText: async ({ to, text, accountId, cfg }) => {
      // 2026.9.x: 出站上下文的 to/accountId 可为 null，归一化为 string | undefined
      const result = await sendMessageNapCat(to ?? "", text ?? "", {
        accountId: accountId ?? undefined,
        cfg,
      });
      return buildChannelSendResult("napcat", result);
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) => {
      const result = await sendMessageNapCat(to ?? "", text ?? "", {
        accountId: accountId ?? undefined,
        cfg,
        // 2026.9.x: mediaUrl 在出站上下文中可为 null（无媒体纯文本场景），NapCatSendOptions 仅接受 undefined
        mediaUrl: mediaUrl ?? undefined,
      });
      return buildChannelSendResult("napcat", result);
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: () => [],
    buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot),
    probeAccount: async ({ account, timeoutMs }) =>
      probeNapCat(account.httpApi, account.accessToken, timeoutMs),
    buildAccountSnapshot: ({ account, runtime }) => {
      const configured = Boolean(account.httpApi?.trim());
      const base = buildBaseAccountStatusSnapshot({
        account: {
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured,
        },
        runtime,
      });
      return {
        ...base,
        mode: "reverse-ws",
        dmPolicy: account.config.dmPolicy ?? "allowlist",
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const httpApi = account.httpApi.trim();

      let botLabel = "";
      try {
        const probe = await probeNapCat(httpApi, account.accessToken, 3000);
        const name = probe.ok ? probe.bot?.nickname?.trim() : null;
        if (name) botLabel = ` (${name}, QQ:${probe.bot?.user_id})`;
        if (!probe.ok) {
          ctx.log?.warn?.(
            `[${account.accountId}] NapCat probe failed: ${probe.error}`,
          );
        }
        ctx.setStatus({
          accountId: account.accountId,
          bot: probe.bot,
        });
      } catch (err) {
        ctx.log?.warn?.(
          `[${account.accountId}] NapCat probe threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const statusSink = createAccountStatusSink({
        accountId: ctx.accountId,
        setStatus: ctx.setStatus,
      });

      // Resolve reverse-WS mode from channel config (default: both).
      //   gateway    — ride the openclaw gateway port via a plugin HTTP route
      //                (registerHttpRoute + handleUpgrade), bypassing the
      //                gateway's connect.challenge handshake that plain
      //                OneBot 11 clients cannot answer.
      //   standalone — legacy behavior: dedicated port 18800+<index>.
      //   both       — register the gateway route AND keep the standalone port.
      const channelSection = (ctx.cfg as unknown as { channels?: Record<string, unknown> })
        .channels?.napcat as { wsMode?: string } | undefined;
      const wsMode = resolveWsMode(channelSection?.wsMode);

      const runtimeEnv = {
        log: (msg: string) => ctx.log?.info(msg),
        error: (msg: string) => ctx.log?.error?.(msg),
      };

      // Gateway-path mode: register this account's context; the route itself
      // is registered once from index.ts at plugin load time.
      if (wsMode !== "standalone") {
        const { registerGatewayAccount, resolveConfiguredGatewayPath } = await import(
          "./gateway-ws.js"
        );
        await registerGatewayAccount({
          account,
          config: ctx.cfg,
          runtime: runtimeEnv,
          statusSink,
        });
        ctx.log?.info(
          `[${account.accountId}] NapCat gateway-path ingress armed at ${resolveConfiguredGatewayPath(ctx.cfg)} (connect NapCat to ws://<gateway-host>:<gateway-port>${resolveConfiguredGatewayPath(ctx.cfg)})`,
        );
      }

      // Standalone-port mode: wait until abort (legacy path).
      if (wsMode === "standalone" || wsMode === "both") {
        // Determine WS port for reverse connection.
        // Use gateway port + 100 + account index offset to avoid conflicts.
        const wsPort = 18800 + listNapCatAccountIds(ctx.cfg).indexOf(account.accountId);

        ctx.log?.info(`[${account.accountId}] starting NapCat provider${botLabel} mode=reverse-ws wsPort=${wsPort}`);

        const { monitorNapCatProvider } = await import("./monitor.js");
        return monitorNapCatProvider({
          account,
          config: ctx.cfg,
          runtime: runtimeEnv,
          abortSignal: ctx.abortSignal,
          wsPort,
          statusSink,
        });
      }

      // Gateway-only mode: nothing to await — hold until abort, then unregister.
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) {
          resolve();
          return;
        }
        ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      const { unregisterGatewayAccount } = await import("./gateway-ws.js");
      unregisterGatewayAccount(account.accountId);
    },
  },
};
