import { GLOSSARY, TERMS } from "./glossary";

test("every term has one plain line under 140 characters", () => {
  expect(TERMS).toHaveLength(14);
  for (const t of TERMS) {
    const line = GLOSSARY[t];
    expect(line, t).toBeTruthy();
    expect(line.length, t).toBeLessThanOrEqual(140);
    expect(line.endsWith("."), t).toBe(true);
    expect(line.includes("\n"), t).toBe(false);
  }
});
