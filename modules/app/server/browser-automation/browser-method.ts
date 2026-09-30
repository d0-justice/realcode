export const BROWSER_METHODS = [
  'browser.observe',
  'browser.act',
  'browser.screenshot',
  'browser.openTab',
  'browser.site',
] as const;

export type BrowserMethod = (typeof BROWSER_METHODS)[number];

export function isBrowserMethod(value: unknown): value is BrowserMethod {
  return typeof value === 'string' && BROWSER_METHODS.includes(value as BrowserMethod);
}
