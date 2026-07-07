import { useLayoutEffect, useRef, useState } from "react";
import { createTextStreamSmoother, type TextStreamSmoother } from "../../lib/textStreamSmoother";
import { DesktopMarkdownMessage } from "./DesktopMarkdownMessage";

export function DesktopStreamingMarkdownMessage({
  content,
  pulseKey,
}: {
  content: string;
  pulseKey: number;
}) {
  const [renderedContent, setRenderedContent] = useState("");
  const smootherRef = useRef<TextStreamSmoother | null>(null);
  const targetContentRef = useRef("");

  useLayoutEffect(() => {
    const smoother = createTextStreamSmoother({
      emit: (text) => {
        setRenderedContent(text);
      },
    });

    smootherRef.current = smoother;

    return () => {
      smoother.cancel();
      smootherRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const nextContent = content || "";
    const smoother = smootherRef.current;
    if (!smoother) {
      targetContentRef.current = nextContent;
      setRenderedContent(nextContent);
      return;
    }

    if (!nextContent) {
      smoother.cancel();
      targetContentRef.current = "";
      setRenderedContent("");
      return;
    }

    const currentTarget = targetContentRef.current;
    if (nextContent === currentTarget) {
      return;
    }

    if (nextContent.startsWith(currentTarget)) {
      const delta = nextContent.slice(currentTarget.length);
      if (!delta) {
        return;
      }
      smoother.push(delta);
    } else if (currentTarget === "" || !currentTarget) {
      smoother.push(nextContent);
    } else {
      // Content diverged (retry/edit reset) — re-seed the smoother's target so
      // subsequent push(delta) calls append to the new base instead of the
      // stale flushed content.
      smoother.replace(nextContent);
    }

    targetContentRef.current = nextContent;
  }, [content, pulseKey]);

  return <DesktopMarkdownMessage content={renderedContent} />;
}
