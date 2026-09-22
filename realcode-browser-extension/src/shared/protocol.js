export const PROTOCOL_VERSION = "realcode-browser-bridge/2";

export const COMMAND_METHODS = Object.freeze([
  "browser.snapshot",
  "browser.click",
  "browser.fill",
  "browser.select",
  "browser.scroll",
  "browser.screenshot",
  "browser.navigate",
  "browser.openTab",
  "browser.switchTab",
  "browser.wait"
]);

const commandSet = new Set(COMMAND_METHODS);

export function isCommand(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.type === "command" &&
      typeof value.id === "string" &&
      commandSet.has(value.method) &&
      (!value.args || typeof value.args === "object")
  );
}

export function serializeError(error) {
  if (error instanceof Error) {
    return { code: "COMMAND_FAILED", message: error.message };
  }
  return { code: "COMMAND_FAILED", message: String(error) };
}
