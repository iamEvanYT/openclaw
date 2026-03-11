import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import { ensureBrowserControlAuth } from "./control-auth.js";
import { ensureChromeExtensionRelayServer } from "./extension-relay.js";
import { createBrowserRuntimeState, stopBrowserRuntime } from "./runtime-lifecycle.js";
import { type BrowserServerState, createBrowserRouteContext } from "./server-context.js";

let state: BrowserServerState | null = null;
const log = createSubsystemLogger("browser");
const logService = log.child("service");

export function getBrowserControlState(): BrowserServerState | null {
  return state;
}

export function createBrowserControlContext() {
  return createBrowserRouteContext({
    getState: () => state,
    refreshConfigFromDisk: true,
  });
}

export async function startBrowserControlServiceFromConfig(): Promise<BrowserServerState | null> {
  if (state) {
    return state;
  }

  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  if (!resolved.enabled) {
    return null;
  }
  try {
    const ensured = await ensureBrowserControlAuth({ cfg });
    if (ensured.generatedToken) {
      logService.info("No browser auth configured; generated gateway.auth.token automatically.");
    }
  } catch (err) {
    logService.warn(`failed to auto-configure browser auth: ${String(err)}`);
  }

  state = await createBrowserRuntimeState({
    server: null,
    port: resolved.controlPort,
    resolved,
    onWarn: (message) => logService.warn(message),
  });

  // If any profile uses the Chrome extension relay, start the local relay server eagerly
  // so the extension can connect before the first browser action.
  for (const name of Object.keys(resolved.profiles)) {
    const profile = resolveProfile(resolved, name);
    if (!profile || profile.driver !== "extension") {
      continue;
    }
    await ensureChromeExtensionRelayServer({
      cdpUrl: profile.cdpUrl,
      allowRemote: resolved.relayAllowRemote,
    }).catch((err: unknown) => {
      logService.warn(`Chrome extension relay init failed for profile "${name}": ${String(err)}`);
    });
  }

  logService.info(
    `Browser control service ready (profiles=${Object.keys(resolved.profiles).length})`,
  );
  return state;
}

export async function stopBrowserControlService(): Promise<void> {
  const current = state;
  await stopBrowserRuntime({
    current,
    getState: () => state,
    clearState: () => {
      state = null;
    },
    onWarn: (message) => logService.warn(message),
  });
}
