import { AppKeys } from "../AppKeys.js";

export const DEFAULT_APP_KEYS_FETCH_TIMEOUT_MS = 10_000;
export const DEFAULT_APP_KEYS_FAST_TIMEOUT_MS = 2_000;

export const cloneAppKeys = (appKeys: AppKeys): AppKeys =>
  new AppKeys(
    appKeys.getAllDevices().map((device) => ({ ...device })),
    appKeys.getAllDeviceLabels().map((labels) => ({ ...labels })),
  );

export const now = (): number => Math.floor(Date.now() / 1000);
