import { QueryClient } from "@tanstack/react-query";

import { invalidateOps } from "./query";

test("invalidateOps invalidates only the named operations", async () => {
  const qc = new QueryClient();
  qc.setQueryData([{ _id: "listKeys", query: { page: 1 } }], 1);
  qc.setQueryData([{ _id: "listAliases" }], 1);
  qc.setQueryData(["plain"], 1);
  await invalidateOps(qc, "listKeys");
  expect(qc.getQueryState([{ _id: "listKeys", query: { page: 1 } }])?.isInvalidated).toBe(true);
  expect(qc.getQueryState([{ _id: "listAliases" }])?.isInvalidated).toBe(false);
  expect(qc.getQueryState(["plain"])?.isInvalidated).toBe(false);
});
