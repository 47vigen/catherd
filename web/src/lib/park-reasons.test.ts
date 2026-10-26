import { QUICK_ANSWERS, REASON_TEXT } from "./park-reasons";

test("every park reason has a plain explanation", () => {
  expect(Object.keys(REASON_TEXT)).toHaveLength(19);
  for (const [reason, text] of Object.entries(REASON_TEXT)) {
    expect(text.length, reason).toBeGreaterThan(20);
    expect(text, reason).not.toContain("_");
  }
});

test("an approval offers Approve plan and Request changes", () => {
  expect(QUICK_ANSWERS.approval).toEqual([
    { label: "Approve plan", answer: "approve" },
    { label: "Request changes", answer: null },
  ]);
});

test("the other reasons with a known fix keep their exact answers", () => {
  expect(QUICK_ANSWERS.push).toEqual([
    { label: "Push the branch", answer: "push" },
    { label: "It is merged", answer: "merged" },
  ]);
  expect(QUICK_ANSWERS.preflight).toEqual([{ label: "Confirm and continue", answer: "confirmed" }]);
  expect(QUICK_ANSWERS.confirm).toEqual([{ label: "Confirm and continue", answer: "confirmed" }]);
  expect(QUICK_ANSWERS.blocker).toEqual([
    { label: "Land with the known issues", answer: "land with the known issues" },
  ]);
  expect(QUICK_ANSWERS.budget).toEqual([
    { label: "Raise the budget", answer: null, href: "/setup?section=budget" },
    { label: "I raised it", answer: "budget raised" },
  ]);
  expect(QUICK_ANSWERS.needs_user).toBeUndefined();
});
