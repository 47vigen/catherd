import { Button, FieldError, Form, Input, Label, TextField, useTheme } from "@heroui/react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { loginMutation } from "../client/@tanstack/react-query.gen";
import { Brand } from "../components/brand/Brand";
import { FanOut } from "../components/brand/FanOut";
import { errorMessage, hasErrorCode } from "../lib/api";
import { safeRedirect } from "../lib/redirect";

export const Route = createFileRoute("/login")({
  validateSearch: (raw: Record<string, unknown>): { redirect?: string } => ({
    redirect: typeof raw.redirect === "string" ? raw.redirect : undefined,
  }),
  component: LoginPage,
});

function LoginPage() {
  useTheme("system");
  const search = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = Route.useRouteContext({ select: (c) => c.queryClient });
  const [token, setToken] = useState("");
  const login = useMutation({
    ...loginMutation(),
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ href: safeRedirect(search.redirect), replace: true });
    },
  });
  const error = login.error
    ? hasErrorCode(login.error, "unauthorized")
      ? "Wrong token."
      : errorMessage(login.error)
    : undefined;

  // The link `catherd panel` prints carries the token in its fragment, which no request or log ever holds.
  const { mutate } = login;
  useEffect(() => {
    const t = new URLSearchParams(location.hash.slice(1)).get("token");
    if (!t) return;
    history.replaceState(null, "", location.pathname + location.search);
    mutate({ body: { token: t } });
  }, [mutate]);

  return (
    <main className="bg-background grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <section className="flex flex-col px-6 py-8 sm:px-12">
        <Brand />
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 py-12">
          <div className="flex flex-col gap-2">
            <h1 className="text-[28px] leading-tight font-medium tracking-[-0.03em]">Sign in to catherd</h1>
            <p className="text-muted text-sm">Paste the token catherd panel printed, or open the link it printed.</p>
          </div>
          <Form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              login.mutate({ body: { token } });
            }}
          >
            <TextField
              name="token"
              type="password"
              isRequired
              autoComplete="off"
              value={token}
              onChange={(v) => {
                setToken(v);
                if (login.error) login.reset();
              }}
              isInvalid={error !== undefined}
            >
              <Label>Token</Label>
              <Input className="h-10" />
              <FieldError>{error}</FieldError>
            </TextField>
            <Button type="submit" variant="primary" size="lg" isPending={login.isPending} fullWidth>
              Sign in
            </Button>
          </Form>
          <p className="text-muted text-xs leading-5">
            A new token is made each time <code className="text-foreground font-mono">catherd panel</code> starts. The
            panel listens on 127.0.0.1 only.
          </p>
        </div>
      </section>
      <aside className="border-border bg-surface relative hidden flex-col justify-between overflow-hidden border-l p-12 lg:flex">
        <p className="label-caps text-muted">[ One session · every agent ]</p>
        <FanOut className="mx-auto max-w-[560px]" />
        <p className="text-muted max-w-sm text-sm leading-6">
          catherd plans, dispatches, reviews and lands each milestone while you are away; a question parks one unit and
          reaches your phone.
        </p>
      </aside>
    </main>
  );
}
