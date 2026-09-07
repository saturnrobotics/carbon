import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  HStack
} from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { useFetcher } from "react-router";
import { useSuppliers } from "~/stores";
import { path } from "~/utils/path";
import type { getInvoiceIntakeReview } from "../../invoicing.server";
import { InvoiceChoiceField, InvoiceTextField } from "./InvoiceDocumentLines";

export function invoiceRuleLabel(sourceText: string) {
  try {
    const source = JSON.parse(sourceText);
    if (source && typeof source === "object")
      return (
        [source.description, source.sku, source.pack]
          .filter((value) => typeof value === "string" && value)
          .join(" · ") || sourceText
      );
  } catch {
    /* Supplier aliases are plain text. */
  }
  return sourceText;
}

type ReviewData = Awaited<ReturnType<typeof getInvoiceIntakeReview>>;
export function InvoiceRecognitionRules({
  intakeId,
  rules,
  permissions
}: {
  intakeId: string;
  rules: ReviewData["rules"];
  permissions: ReviewData["permissions"];
}) {
  const { t } = useLingui();
  const [suppliers] = useSuppliers();
  const [changes, setChanges] = useState<
    Record<string, { supplierId?: string; reason?: string }>
  >({});
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const submit = (
    rule: ReviewData["rules"][number],
    operation: "replace" | "disable"
  ) =>
    fetcher.submit(
      JSON.stringify({
        action: "rule",
        operation,
        id: rule.id,
        expectedVersion: rule.version,
        ...changes[rule.id]
      }),
      {
        method: "post",
        encType: "application/json",
        action: path.to.invoiceIntakeAction(intakeId)
      }
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Trans>Saved recognition rules</Trans>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm">
          <Trans>
            Rules remember identities and purchasing units. Prices, quantities,
            dates, and payment status always come from the current document.
            Correct an item rule in the line review and approve the correction
            with a reason.
          </Trans>
        </p>
        {fetcher.data?.error && (
          <p role="alert" className="text-destructive">
            {fetcher.data.error}
          </p>
        )}
        {!rules.length && (
          <p className="text-sm text-muted-foreground">
            <Trans>No saved rules for this document yet.</Trans>
          </p>
        )}
        {rules.map((rule) => (
          <div key={rule.id} className="space-y-2 border-t pt-3">
            <p className="text-sm">
              {rule.kind === "supplierAlias"
                ? t`Supplier name`
                : t`Supplier item and pack`}{" "}
              · {t`Version`} {rule.version}
            </p>
            <p className="text-sm whitespace-pre-wrap break-words">
              {invoiceRuleLabel(rule.sourceText)}
            </p>
            {rule.kind === "supplierAlias" && (
              <>
                <InvoiceChoiceField
                  label={t`Correct supplier`}
                  value={changes[rule.id]?.supplierId ?? rule.supplierId}
                  options={suppliers.map((supplier) => ({
                    value: supplier.id,
                    label: supplier.name
                  }))}
                  onChange={(supplierId) =>
                    setChanges((previous) => ({
                      ...previous,
                      [rule.id]: {
                        ...previous[rule.id],
                        supplierId: supplierId ?? undefined
                      }
                    }))
                  }
                  disabled={!permissions.canUpdateSupplier}
                />
                <InvoiceTextField
                  label={t`Reason for correction`}
                  value={changes[rule.id]?.reason ?? null}
                  onChange={(reason) =>
                    setChanges((previous) => ({
                      ...previous,
                      [rule.id]: {
                        ...previous[rule.id],
                        reason: reason ?? undefined
                      }
                    }))
                  }
                  disabled={!permissions.canUpdateSupplier}
                />
              </>
            )}
            <HStack>
              {rule.kind === "supplierAlias" && (
                <Button
                  variant="secondary"
                  isDisabled={
                    !permissions.canUpdate ||
                    !permissions.canUpdateSupplier ||
                    !changes[rule.id]?.supplierId ||
                    !changes[rule.id]?.reason?.trim()
                  }
                  onClick={() => submit(rule, "replace")}
                  isLoading={fetcher.state !== "idle"}
                >
                  <Trans>Replace supplier rule</Trans>
                </Button>
              )}
              <Button
                variant="ghost"
                isDisabled={
                  !permissions.canUpdate ||
                  !permissions.canUpdateSupplier ||
                  (rule.kind === "itemAlias" && !permissions.canUpdateItems)
                }
                onClick={() => submit(rule, "disable")}
                isLoading={fetcher.state !== "idle"}
              >
                <Trans>Disable rule</Trans>
              </Button>
            </HStack>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
