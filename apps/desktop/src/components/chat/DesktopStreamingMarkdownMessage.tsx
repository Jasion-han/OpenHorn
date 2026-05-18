import { useLayoutEffect, useRef, useState } from "react";
import { createTextStreamSmoother, type TextStreamSmoother } from "../../lib/textStreamSmoother";
import { DesktopMarkdownMessage } from "./DesktopMarkdownMessage";

export function DesktopStreamingMarkdownMessage({
  content,
  tailLength: _tailLength,
  pulseKey,
}: {
  content: string;
  tailLength: number;
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
      smoother.cancel({ flush: true });
      setRenderedContent(nextContent);
    }

    targetContentRef.current = nextContent;
  }, [content, pulseKey]);

  return <DesktopMarkdownMessage content={renderedContent} />;
}
