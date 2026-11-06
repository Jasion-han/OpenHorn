import { expect, test } from "bun:test";
import { parseInlineLocalPath } from "./localPathReference";

test("exact standalone local paths preserve filenames and existing line ranges", () => {
  expect(parseInlineLocalPath("/Users/han/Downloads/hello.txt")).toEqual({
    path: "/Users/han/Downloads/hello.txt",
  });
  expect(parseInlineLocalPath("/Users/han/My Notes/中文.txt:12-20")).toEqual({
    path: "/Users/han/My Notes/中文.txt",
    line: 12,
    endLine: 20,
  });
  expect(parseInlineLocalPath("~/Downloads/test.txt")).toEqual({ path: "~/Downloads/test.txt" });
  expect(parseInlineLocalPath("C:\\Users\\han\\Notes.txt")).toEqual({
    path: "C:\\Users\\han\\Notes.txt",
  });
  expect(parseInlineLocalPath("file:///Users/han/My%20Notes/a.txt")).toEqual({
    path: "/Users/han/My Notes/a.txt",
  });
});
test("commands, ordinary code, web links and remote file URIs stay ordinary code", () => {
  for (const value of [
    "ls -la",
    "rm /Users/han/test.txt",
    "/bin/ls -la",
    "/bin/cat /tmp/a",
    "/usr/bin/python script.py",
    "cat /tmp/a",
    "https://example.com/a.txt",
    "file://server/share/a.txt",
    "/tmp/a.txt\n/tmp/b.txt",
    "value = 42",
    "/tmp/a && rm /tmp/b",
  ]) {
    expect(parseInlineLocalPath(value)).toBe(undefined);
  }
});
