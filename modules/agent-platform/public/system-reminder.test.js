import { expect, test } from "bun:test";
import { splitSystemReminderBlocks } from "./system-reminder.js";

test("keeps system context separate from visible user text", () => {
  expect(splitSystemReminderBlocks("<system-reminder>secret context</system-reminder> hello")).toEqual([
    { kind: "system", text: "<system-reminder>secret context</system-reminder>" },
    { kind: "text", text: "hello" },
  ]);
  expect(splitSystemReminderBlocks("Explain <system-reminder> tag")).toEqual([
    { kind: "text", text: "Explain <system-reminder> tag" },
  ]);
});
