import { render } from "@testing-library/react";

import { backendName, ProviderIcon, providerOf } from "./ProviderIcon";

test("maps every backend to its mark, a monogram or nothing", () => {
  expect(providerOf("claude")).toBe("anthropic");
  expect(providerOf("claude-code")).toBe("anthropic");
  expect(providerOf("claude-code:claude-opus-5-5#high")).toBe("anthropic");
  expect(providerOf("codex:gpt-6-sol#xhigh")).toBe("openai");
  expect(providerOf("opencode")).toBe("opencode");
  expect(providerOf("opencode-go:glm-5#medium")).toBe("opencode");
  expect(providerOf("cursor")).toBe("cursor");
  expect(providerOf("mystery")).toBeNull();
  expect(backendName("claude-code:x#low")).toBe("Claude Code");
  expect(backendName("claude")).toBe("Claude");
  expect(backendName("codex")).toBe("Codex");
  expect(backendName("opencode-go:x")).toBe("opencode");
  expect(backendName("cursor")).toBe("Cursor");
  expect(backendName("mystery")).toBe("mystery");

  expect(render(<ProviderIcon backend="codex:gpt-6-sol#high" />).container.querySelector("svg")).not.toBeNull();
  expect(render(<ProviderIcon backend="cursor" />).container.querySelector("svg")).not.toBeNull();
  expect(render(<ProviderIcon backend="mystery" />).container).toHaveTextContent("M");
});

test("is hidden from assistive tech", () => {
  const { container } = render(<ProviderIcon backend="claude" />);
  expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
});
