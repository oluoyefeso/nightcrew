import { DEFAULT_DELIVERY, type DeliveryPolicy, type Repo } from "@nightcrew/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { Field, Select, TextInput } from "./form";
import { Button } from "./ui";
export function DeliveryEditor({ repo }: { repo: Repo }) {
  const [policy, setPolicy] = useState<DeliveryPolicy>(repo.delivery ?? DEFAULT_DELIVERY);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => api.patch(`/api/repos/${repo.id}/delivery`, policy),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["repos"] });
      qc.invalidateQueries({ queryKey: ["operations"] });
    },
  });
  return (
    <details className="rounded-xl bg-raised/40 p-4">
      <summary className="cursor-pointer text-[14px] font-medium">
        Delivery ·{" "}
        {repo.delivery?.automatic === "off" || !repo.delivery
          ? "Manual"
          : `Automatic through ${repo.delivery.automatic}`}
      </summary>
      <div className="mt-4 grid gap-4">
        <p className="text-[13px] text-muted">
          Check → deploy → release. Commands run in an isolated checkout of the local branch commit, with NC_COMMIT and
          NC_BRANCH set. Deployment and release commands must use that commit and return only when their result is
          known.
        </p>
        {(["branch", "check", "deploy", "release"] as const).map((key) => (
          <Field
            key={key}
            label={
              {
                branch: "Local delivery branch",
                check: "Combined verification command",
                deploy: "Deployment command",
                release: "Release command",
              }[key]
            }
            htmlFor={`delivery-${repo.id}-${key}`}
          >
            <TextInput
              id={`delivery-${repo.id}-${key}`}
              value={policy[key]}
              maxLength={4000}
              onChange={(e) => setPolicy({ ...policy, [key]: e.target.value })}
            />
          </Field>
        ))}
        <Field
          label="Delivery authority"
          htmlFor={`delivery-authority-${repo.id}`}
          hint="Saving an automatic policy authorises these commands for new commits while dispatch is enabled. Repository merge authority stays separate."
        >
          <Select
            id={`delivery-authority-${repo.id}`}
            value={policy.automatic}
            onChange={(e) => setPolicy({ ...policy, automatic: e.target.value as DeliveryPolicy["automatic"] })}
          >
            <option value="off">I start each stage</option>
            <option value="check">Run checks automatically</option>
            <option value="deploy">Check and deploy automatically</option>
            <option value="release">Check, deploy and release automatically</option>
          </Select>
        </Field>
        <Field
          label="Credential environment names"
          htmlFor={`delivery-env-${repo.id}`}
          hint="Comma-separated names set in the runner's environment. Never paste secret values. Only deploy/release receive these variables."
        >
          <TextInput
            id={`delivery-env-${repo.id}`}
            value={policy.environment.join(", ")}
            onChange={(e) =>
              setPolicy({
                ...policy,
                environment: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            placeholder="DEPLOY_TOKEN"
          />
        </Field>
        <p className="text-[12px] text-muted">
          Failed or interrupted external actions wait for you. Inspect the provider before retrying to avoid duplicate
          deployments or releases.
        </p>
        <div>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            Save delivery settings
          </Button>
        </div>
        {save.error && (
          <p role="alert" className="text-bad">
            {save.error.message}
          </p>
        )}
      </div>
    </details>
  );
}
