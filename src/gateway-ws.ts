/**
 * Gateway-path WebSocket ingress for NapCat.
 *
 * Why this exists: openclaw 2026.9.x gateways issue a `connect.challenge`
 * handshake on every WebSocket that lands on the gateway's own WS endpoint.
 * NapCat speaks plain OneBot 11 and cannot answer that challenge, so
 * connections pointed at the gateway port always time out.
 *
 * Solution: register a plugin HTTP route (`registerHttpRoute`) with an
 * `handleUpgrade` hook. Plugin routes are dispatched BEFORE the gateway's
 * default WS handler in the upgrade chain, so a NapCat connection to
 * `ws://gateway:<port>/napcat/ws` is handed to us directly — no
 * connect.challenge, pure OneBot 11.
 *
 * Auth model: `auth: "plugin"` means the gateway skips its own auth for this
 * route; we enforce OneBot 11 `access_token` ourselves (Authorization: Bearer
 * header or `?access_token=` query param, per OneBot 11 spec).
 */
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedNapCatAccount } from "./types.js";
import type { NapCatRuntimeEnv } from "./monitor.js";

export const DEFAULT_GATEWAY_WS_PATH = "/napcat/ws";

/** Registered account entry for the gateway-path upgrade dispatcher. */
type GatewayAccountEntry = {
  account: ResolvedNapCatAccount;
  config: OpenClawConfig;
  runtime: NapCatRuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

/** One WebSocketServer in noServer mode, shared by all accounts on the path. */
let sharedWss: WebSocketServer | null = null;
/** accountId -> connection context; resolves which account an upgrade belongs to. */
const gatewayAccounts = new Map<string, GatewayAccountEntry>();
/** Lazily imported monitor module (avoids a circular import at module load). */
let monitorModule: typeof import("./monitor.js") | null = null;
let runtimeModule: typeof import("./runtime.js") | null = null;

function getSharedWss(): WebSocketServer {
  if (!sharedWss) {
    sharedWss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  }
  return sharedWss;
}

/** Normalize a configured path to a canonical form starting with "/". */
export function normalizeGatewayPath(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return DEFAULT_GATEWAY_WS_PATH;
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  // Collapse trailing slash except for the root path itself.
  return withSlash.length > 1 && withSlash.endsWith("/")
    ? withSlash.slice(0, -1)
    : withSlash;
}

/** Extract and validate the OneBot 11 access token from a request. */
function extractAccessToken(req: IncomingMessage): string | undefined {
  // OneBot 11: Authorization: Bearer <token> (preferred) or ?access_token=<token>
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const queryToken = url.searchParams.get("access_token");
  return queryToken ?? undefined;
}

/** Resolve which account a gateway-path upgrade should attach to. */
function resolveAccountForUpgrade(params: {
  req: IncomingMessage;
  cfg: OpenClawConfig;
}): { accountId: string } | { error: string } {
  const { req } = params;
  const url = new URL(req.url ?? "/", "http://localhost");
  // Account routing, in priority order:
  // 1. ?account=<accountId> query param (explicit)
  // 2. x-self-id header (NapCat always sends it on reverse WS connections)
  // 3. single configured account (only when exactly one exists)
  const explicitAccount = url.searchParams.get("account");
  if (explicitAccount) {
    if (gatewayAccounts.has(explicitAccount)) return { accountId: explicitAccount };
    return { error: `unknown account "${explicitAccount}"` };
  }
  const selfIdHeader = req.headers["x-self-id"];
  if (typeof selfIdHeader === "string" && selfIdHeader) {
    for (const [accountId, entry] of gatewayAccounts) {
      if (entry.account.selfId === selfIdHeader) return { accountId };
    }
  }
  if (gatewayAccounts.size === 1) {
    return { accountId: [...gatewayAccounts.keys()][0] };
  }
  return {
    error: `ambiguous connection: ${gatewayAccounts.size} accounts registered; add ?account=<id> or x-self-id header`,
  };
}

/**
 * Build the registerHttpRoute params for the gateway WS endpoint.
 * Called once from index.ts; the returned handleUpgrade dispatches upgrades
 * to the correct account based on query params / x-self-id header.
 */
export function createNapCatGatewayRouteRegistration(params: {
  cfg: OpenClawConfig;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}): {
  path: string;
  auth: "plugin";
  match: "exact";
  handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>;
} {
  const cfg = params.cfg;
  const path = resolveConfiguredGatewayPath(cfg);

  const handler = (
    _req: IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => {
    res.writeHead(426, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(
      "Upgrade Required: connect NapCat reverse WebSocket to this path (OneBot 11 over WS).",
    );
  };

  const handleUpgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const log = params.log ?? (() => {});
    const error = params.error ?? (() => {});
    try {
      // No accounts registered (channel not started) — reject politely.
      if (gatewayAccounts.size === 0) {
        error("NapCat gateway WS: no accounts registered (channel not started)");
        socket.destroy();
        return;
      }

      // OneBot 11 access_token enforcement when configured.
      const resolution = resolveAccountForUpgrade({ req, cfg });
      if ("error" in resolution) {
        error(`NapCat gateway WS: ${resolution.error}`);
        socket.destroy();
        return;
      }
      const entry = gatewayAccounts.get(resolution.accountId);
      if (!entry) {
        error(`NapCat gateway WS: account ${resolution.accountId} not registered`);
        socket.destroy();
        return;
      }
      if (entry.account.accessToken) {
        const presented = extractAccessToken(req);
        if (presented !== entry.account.accessToken) {
          error(
            `NapCat gateway WS: access_token mismatch for account ${resolution.accountId}`,
          );
          socket.destroy();
          return;
        }
      }

      const wss = getSharedWss();
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        log(`NapCat gateway WS: upgrade ok account=${resolution.accountId}`);
        // Modules are preloaded by registerGatewayAccount; attach synchronously
        // so no inbound frame is ever dropped.
        attachConnection(ws, req, entry);
      });
    } catch (err) {
      error(`NapCat gateway WS: upgrade failed: ${String(err)}`);
      socket.destroy();
    }
  };

  return { path, auth: "plugin", match: "exact", handler, handleUpgrade };
}

function attachConnection(
  ws: WebSocket,
  req: IncomingMessage,
  entry: GatewayAccountEntry,
): void {
  if (!monitorModule || !runtimeModule) {
    // Should not happen (registerGatewayAccount preloads), but degrade safely.
    entry.runtime.error?.("NapCat gateway WS: modules not preloaded; dropping connection");
    ws.close(1011, "internal error");
    return;
  }
  monitorModule.handleNapCatConnection({
    ws,
    req,
    account: entry.account,
    config: entry.config,
    runtime: entry.runtime,
    core: runtimeModule.getNapCatRuntime(),
    statusSink: entry.statusSink,
  });
}

/** Read the effective gateway path from channel config. */
export function resolveConfiguredGatewayPath(cfg: OpenClawConfig): string {
  const channelCfg = (cfg as unknown as { channels?: Record<string, unknown> }).channels
    ?.napcat as { gatewayPath?: string } | undefined;
  return normalizeGatewayPath(channelCfg?.gatewayPath);
}

/**
 * Register (or replace) an account's connection context for gateway-path mode.
 * Called by the channel startAccount hook when wsMode is gateway/both.
 * Also preloads the monitor/runtime modules so upgrades can attach message
 * listeners synchronously (no lost first messages).
 */
export async function registerGatewayAccount(params: {
  account: ResolvedNapCatAccount;
  config: OpenClawConfig;
  runtime: NapCatRuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  if (!monitorModule) monitorModule = await import("./monitor.js");
  if (!runtimeModule) runtimeModule = await import("./runtime.js");
  gatewayAccounts.set(params.account.accountId, {
    account: params.account,
    config: params.config,
    runtime: params.runtime,
    statusSink: params.statusSink,
  });
}

/** Unregister an account's gateway context (channel stop / reload). */
export function unregisterGatewayAccount(accountId: string): void {
  gatewayAccounts.delete(accountId);
}
