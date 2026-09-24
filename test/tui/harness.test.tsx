import { useKeyboard } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { useState } from "react";
import { describe, expect, it } from "bun:test";
import { KEY, press } from "./helpers.ts";

function Counter() {
  const [n, setN] = useState(0);
  useKeyboard((key) => {
    if (key.name === "down") setN((x) => x + 1);
  });
  return <text content={`down ${n}`} />;
}

describe("opentui test harness", () => {
  it("renders a frame and delivers keys", async () => {
    const { renderOnce, captureCharFrame, mockInput } = await testRender(<Counter />, {
      width: 20,
      height: 3,
    });
    await renderOnce();
    expect(captureCharFrame().trim()).toBe("down 0");
    await press(mockInput, KEY.down, KEY.down);
    await renderOnce();
    expect(captureCharFrame().trim()).toBe("down 2");
  });
});
