import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { napCatPlugin } from "./src/channel.js";
import { setNapCatRuntime } from "./src/runtime.js";
import { createNapCatGatewayRouteRegistration } from "./src/gateway-ws.js";

const plugin = {
  id: "napcat",
  name: "QQ (NapCat)",
  description: "QQ channel plugin via NapCat (OneBot 11 reverse WebSocket)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setNapCatRuntime(api.runtime);
    // 2026.9.x: OpenClawPluginChannelRegistration 仅接受 plugin 字段（dock 已移除）。
    api.registerChannel(napCatPlugin);

    // 2026.9.x connect.challenge compatibility: register a gateway WS route
    // so NapCat's plain OneBot 11 reverse connection rides the gateway port
    // through the plugin-route upgrade chain (dispatched BEFORE the gateway's
    // default WS handler, hence never receives connect.challenge).
    // Route only becomes active when wsMode is gateway/both (accounts register
    // themselves at channel start); here we just arm the route with config.
    api.registerHttpRoute(
      createNapCatGatewayRouteRegistration({
        cfg: api.config,
        log: (msg) => api.logger?.info?.(msg),
        error: (msg) => api.logger?.error?.(msg),
      }),
    );
  },
};

export default plugin;

