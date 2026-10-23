import { Alert, Button } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getSetupQueryKey,
  getVersionOptions,
  getVersionQueryKey,
  setHostMutation,
} from "../../../client/@tanstack/react-query.gen";
import { ProviderIcon } from "../../../components/provider-icon/ProviderIcon";

const HOSTS = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
] as const;

/** Asks once which app runs catherd; Setup is read-only until the host is known. */
export function HostPrompt() {
  const queryClient = useQueryClient();
  const version = useQuery(getVersionOptions());
  const setHost = useMutation({
    ...setHostMutation(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getVersionQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getSetupQueryKey() }),
      ]);
    },
  });
  if (version.data?.host !== "unknown") return null;
  return (
    <Alert status="accent" role="alert">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>Which app do you run catherd from?</Alert.Title>
        <Alert.Description>Setup stays read-only until you choose. catherd never guesses.</Alert.Description>
        {setHost.isError ? <p className="text-danger mt-1 text-sm">{setHost.error.error.message}</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          {HOSTS.map(({ id, label }) => (
            <Button
              key={id}
              size="sm"
              variant="secondary"
              isPending={setHost.isPending && setHost.variables?.body.host === id}
              isDisabled={setHost.isPending}
              onPress={() => setHost.mutate({ body: { host: id } })}
            >
              <ProviderIcon backend={id} size="xs" />
              {label}
            </Button>
          ))}
        </div>
      </Alert.Content>
    </Alert>
  );
}
