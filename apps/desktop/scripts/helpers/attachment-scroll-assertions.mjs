/** Test navigation only: wait for real virtualizer measurements before clicking. */
export async function prepareAttachmentPosition(page, messageKey, expected) {
  return page.evaluate(
    async ({ messageKey, expected }) => {
      let stable = 0;
      for (let frame = 0; frame < 240; frame++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const chip = document.querySelector(
          `[data-chat-message-key="${messageKey}"] :is([data-chat-attachment-index], [data-chat-user-link-index], [data-chat-local-path-id])`,
        );
        const viewport = chip?.closest("[data-chat-scroll-viewport]");
        if (!chip || !viewport) continue;
        const delta =
          chip.getBoundingClientRect().top - viewport.getBoundingClientRect().top - expected;
        if (Math.abs(delta) > 0.5)
          window.attachmentScrollVirtualizer.scrollToOffset(viewport.scrollTop + delta);
        stable = Math.abs(delta) < 2 ? stable + 1 : 0;
        if (stable >= 8) return;
      }
      throw new Error(`Unable to prepare initial viewport for ${messageKey}`);
    },
    { messageKey, expected },
  );
}

/** Acceptance assertions never drive scrolling or repair the product's position. */
export async function waitForAttachmentPosition(page, messageKey, expected) {
  return page.evaluate(
    async ({ messageKey, expected }) => {
      let stable = 0;
      let actual;
      for (let frame = 0; frame < 180; frame++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const chip = document.querySelector(
          `[data-chat-message-key="${messageKey}"] :is([data-chat-attachment-index], [data-chat-user-link-index], [data-chat-local-path-id])`,
        );
        const viewport = chip?.closest("[data-chat-scroll-viewport]");
        actual =
          chip && viewport
            ? chip.getBoundingClientRect().top - viewport.getBoundingClientRect().top
            : undefined;
        stable = actual !== undefined && Math.abs(actual - expected) < 2 ? stable + 1 : 0;
        if (stable >= 8) return actual;
      }
      throw new Error(`Unstable anchor ${messageKey}: expected ${expected}, actual ${actual}`);
    },
    { messageKey, expected },
  );
}
