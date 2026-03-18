import { expect, test } from "bun:test";
import { normalizeConversationModelInput } from "./conversationService";

test("normalizeConversationModelInput keeps both channelId+modelId or strips both", () => {
  expect(normalizeConversationModelInput({ channelId: "c", modelId: "m" })).toEqual({
    channelId: "c",
    modelId: "m",
  });
  expect(normalizeConversationModelInput({ channelId: "c" })).toEqual({
    channelId: null,
    modelId: null,
  });
  expect(normalizeConversationModelInput({ modelId: "m" })).toEqual({
    channelId: null,
    modelId: null,
  });
  expect(normalizeConversationModelInput({})).toEqual({ channelId: null, modelId: null });
});
