const DEFAULTS = Object.freeze({
  serverUrl: "ws://127.0.0.1:4173/browser-extension",
  pairingToken: "",
  autoConnect: true,
  selectedTabId: null,
  fallbackTabId: null,
  retryPolicyVersion: 0
});

export async function getSettings() {
  return chrome.storage.local.get(DEFAULTS);
}

export async function updateSettings(patch) {
  const allowed = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (Object.hasOwn(patch, key)) allowed[key] = patch[key];
  }
  await chrome.storage.local.set(allowed);
  return getSettings();
}

export async function getOrCreateClientId() {
  const stored = await chrome.storage.local.get({ clientId: "" });
  if (stored.clientId) return stored.clientId;
  const clientId = crypto.randomUUID();
  await chrome.storage.local.set({ clientId });
  return clientId;
}
