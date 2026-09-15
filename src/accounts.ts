import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId as sdkNormalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { normalizeSecretInputString as sdkNormalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type { SecretInput } from "openclaw/plugin-sdk/secret-input";
import type { NapCatAccountConfig, NapCatConfig, ResolvedNapCatAccount } from "./types.js";

// 使用官方 SDK 的 normalizeAccountId（2026.9.x 签名: (value: string | undefined | null) => string）
function normalizeAccountId(id: string | null | undefined): string {
  return sdkNormalizeAccountId(id);
}

// 使用官方 SDK 逻辑的 normalizeSecretInputString（新签名接受 unknown，返回 string | undefined）
// 注意：config.accessToken 为 SecretInput（可能是 SecretRef 对象），仅接受字面量字符串。
function normalizeSecretInputString(input: string | SecretInput | undefined | null): string | undefined {
  if (typeof input !== "string") return undefined;
  const resolved = sdkNormalizeSecretInputString(input);
  return typeof resolved === "string" ? resolved : undefined;
}

// OpenClawConfig.channels 是强类型 Record（不含自定义通道 napcat），需要经 unknown 中转读取
function getNapCatSection(cfg: OpenClawConfig): NapCatConfig | undefined {
  const channels = (cfg as unknown as { channels?: Record<string, unknown> }).channels;
  return channels?.napcat as NapCatConfig | undefined;
}

function mergeNapCatAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): NapCatAccountConfig {
  const section = getNapCatSection(cfg);
  if (!section) return {};

  const base: NapCatAccountConfig = {
    name: section.name,
    enabled: section.enabled,
    httpApi: section.httpApi,
    accessToken: section.accessToken,
    selfId: section.selfId,
    dmPolicy: section.dmPolicy,
    allowFrom: section.allowFrom,
    groupPolicy: section.groupPolicy,
    groupAllowFrom: section.groupAllowFrom,
    mediaMaxMb: section.mediaMaxMb,
    responsePrefix: section.responsePrefix,
  };

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return base;
  }

  const accountConfig = section.accounts?.[accountId];
  if (!accountConfig) return base;

  // Account-level overrides base-level
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(accountConfig).filter(([, v]) => v !== undefined),
    ),
  };
}

export function resolveNapCatAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedNapCatAccount {
  const accountId = normalizeAccountId(params.accountId);
  const config = mergeNapCatAccountConfig(params.cfg, accountId);
  const section = getNapCatSection(params.cfg);

  const baseEnabled = section?.enabled !== false;
  const accountEnabled = config.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const httpApi = (config.httpApi ?? "").trim();
  const accessToken = normalizeSecretInputString(config.accessToken) ?? "";
  const selfId = String(config.selfId ?? "").trim();

  return {
    accountId,
    name: config.name?.trim(),
    enabled,
    httpApi,
    accessToken,
    selfId,
    config,
  };
}

export function listNapCatAccountIds(cfg: OpenClawConfig): string[] {
  const section = getNapCatSection(cfg);
  if (!section) return [];

  const ids = new Set<string>();
  // Base config counts as default account
  if (section.httpApi || section.accessToken || section.selfId) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }
  if (section.accounts) {
    for (const id of Object.keys(section.accounts)) {
      ids.add(normalizeAccountId(id));
    }
  }
  if (ids.size === 0) ids.add(DEFAULT_ACCOUNT_ID);
  return [...ids];
}

export function resolveDefaultNapCatAccountId(cfg: OpenClawConfig): string {
  const section = getNapCatSection(cfg);
  if (section?.defaultAccount) {
    return normalizeAccountId(section.defaultAccount);
  }
  return DEFAULT_ACCOUNT_ID;
}
