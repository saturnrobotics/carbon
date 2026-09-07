import {
  type InvoiceItemType,
  invoiceItemTypes,
  invoiceLineTypes
} from "@carbon/jobs";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Combobox,
  HStack,
  Input,
  Label,
  NumberField,
  NumberInput,
  NumberInputGroup
} from "@carbon/react";
import { INPUT_FORMAT } from "@carbon/utils";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ComponentProps } from "react";
import { useId, useState } from "react";
import { DeferredMasterCreation } from "~/components/Form/DeferredMasterCreation";
import ConsumableForm from "~/modules/items/ui/Consumables/ConsumableForm";
import MaterialForm from "~/modules/items/ui/Materials/MaterialForm";
import PartForm from "~/modules/items/ui/Parts/PartForm";
import ServiceForm from "~/modules/items/ui/Services/ServiceForm";
import ToolForm from "~/modules/items/ui/Tools/ToolForm";
import { useItems } from "~/stores";
import { setCustomFields } from "~/utils/form";
import {
  invoiceProposalKey,
  updateInvoiceReviewLine
} from "../../invoice-intake.utils";
import {
  type InvoiceIntakeReviewLine,
  invoiceIntakeLineValidator
} from "../../invoicing.models";
import { invoiceItemProposalUnit } from "./invoice-document.utils";
import { useInvoiceDocumentLabels } from "./useInvoiceDocumentLabels";

export type InvoiceChoice = { value: string; label: string };
export function InvoiceTextField({
  label,
  value,
  onChange,
  type = "text",
  disabled = false
}: {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  type?: "text" | "date" | "email";
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value ?? ""}
        isDisabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
      />
    </div>
  );
}
export function InvoiceDecimalField({
  label,
  value,
  onChange,
  disabled = false,
  formatOptions = INPUT_FORMAT.quantity
}: {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  formatOptions?: Intl.NumberFormatOptions;
}) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <NumberField
        aria-label={label}
        value={value === null ? Number.NaN : Number(value)}
        onChange={(value) =>
          onChange(Number.isFinite(value) ? String(value) : null)
        }
        formatOptions={formatOptions}
        isDisabled={disabled}
      >
        <NumberInputGroup>
          <NumberInput id={id} />
        </NumberInputGroup>
      </NumberField>
    </div>
  );
}
export function InvoiceChoiceField({
  label,
  value,
  options,
  onChange,
  disabled = false
}: {
  label: string;
  value: string | null;
  options: InvoiceChoice[];
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Combobox
        id={id}
        aria-label={label}
        value={value ?? ""}
        options={options}
        onChange={(value) => onChange(value || null)}
        isClearable
        isReadOnly={disabled}
      />
    </div>
  );
}
export function InvoiceToggle({
  label,
  checked,
  onChange,
  disabled = false
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <HStack>
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        disabled={disabled}
      />
      <Label htmlFor={id}>{label}</Label>
    </HStack>
  );
}

export function InvoiceItemProposal({
  line,
  units,
  onUse,
  onClose
}: {
  line: InvoiceIntakeReviewLine;
  units: InvoiceChoice[];
  onUse: (proposal: NonNullable<InvoiceIntakeReviewLine["newItem"]>) => void;
  onClose: () => void;
}) {
  const itemType = line.lineType as InvoiceItemType;
  const defaults = {
    id: "",
    name: line.description ?? "",
    description: line.description ?? "",
    revision: "0",
    mpn: line.manufacturerPartNumber ?? "",
    itemTrackingType: itemType === "Service" ? "Non-Inventory" : "Inventory",
    replenishmentSystem: "Buy",
    defaultMethodType:
      itemType === "Service" ? "Purchase to Order" : "Pull from Inventory",
    unitOfMeasureCode: invoiceItemProposalUnit(
      line,
      units.map((unit) => unit.value)
    ),
    lotSize: 0,
    shelfLifeCalculateFromBom: false,
    tags: [],
    ...(line.newItem?.data ?? {})
  };
  const onPropose = (values: Record<string, unknown>, form: FormData) => {
    onUse({
      type: itemType,
      data: {
        ...values,
        tags: defaults.tags,
        id: String(form.get("id") ?? values.id ?? ""),
        name: String(form.get("name") ?? values.name ?? "")
      },
      customFields: setCustomFields(form)
    });
    onClose();
  };
  const shared = { type: "modal" as const, onClose, onPropose };
  // These are the native forms; their validators own class-specific fields.
  switch (itemType) {
    case "Part":
      return (
        <PartForm
          {...shared}
          initialValues={
            defaults as ComponentProps<typeof PartForm>["initialValues"]
          }
        />
      );
    case "Material":
      return (
        <MaterialForm
          {...shared}
          initialValues={
            defaults as ComponentProps<typeof MaterialForm>["initialValues"]
          }
        />
      );
    case "Consumable":
      return (
        <ConsumableForm
          {...shared}
          initialValues={
            defaults as ComponentProps<typeof ConsumableForm>["initialValues"]
          }
        />
      );
    case "Tool":
      return (
        <ToolForm
          {...shared}
          initialValues={
            defaults as ComponentProps<typeof ToolForm>["initialValues"]
          }
        />
      );
    case "Service":
      return (
        <ServiceForm
          {...shared}
          initialValues={
            defaults as ComponentProps<typeof ServiceForm>["initialValues"]
          }
        />
      );
  }
}

export function InvoiceDocumentLines({
  lines,
  onChange,
  onExclude,
  locations,
  units,
  currencyDecimals,
  accounts,
  assets,
  invoiceLines = [],
  recognitionRules = [],
  modelSuggestions = [],
  canCreateTypes,
  selectedItems,
  canRemember,
  canReplaceRule,
  readOnly = false
}: {
  lines: InvoiceIntakeReviewLine[];
  onChange: (lines: InvoiceIntakeReviewLine[]) => void;
  onExclude: (lineKey: string, reason: string) => void;
  locations: InvoiceChoice[];
  units: InvoiceChoice[];
  currencyDecimals: number | null;
  accounts: InvoiceChoice[];
  assets: InvoiceChoice[];
  invoiceLines?: (InvoiceChoice & { updatedAt?: string })[];
  recognitionRules?: InvoiceChoice[];
  modelSuggestions?: {
    lineKey: string;
    itemId: string | null;
    suggestedType: InvoiceItemType | null;
    reason: string;
    confidence: number | null;
  }[];
  canCreateTypes: readonly InvoiceItemType[];
  selectedItems: {
    id: string;
    name: string;
    readableId: string;
    type: string;
    active: boolean;
    unitOfMeasureCode: string | null;
  }[];
  canRemember: boolean;
  canReplaceRule: boolean;
  readOnly?: boolean;
}) {
  const { t } = useLingui();
  const statusLabel = useInvoiceDocumentLabels();
  const [storedItems] = useItems();
  const items = [
    ...new Map(
      [
        ...storedItems.map((item) => ({
          ...item,
          readableId: item.readableIdWithRevision
        })),
        ...selectedItems
      ].map((item) => [item.id, item])
    ).values()
  ];
  const [proposing, setProposing] = useState<string | null>(null);
  const [exclusionReasons, setExclusionReasons] = useState<
    Record<string, string>
  >({});
  const patch = (key: string, change: Partial<InvoiceIntakeReviewLine>) =>
    onChange(
      lines.map((line) =>
        line.lineKey === key
          ? updateInvoiceReviewLine(line, change, currencyDecimals)
          : line
      )
    );
  const proposalLine = lines.find((line) => line.lineKey === proposing);
  return (
    <div className="space-y-4">
      {lines.map((line, index) => (
        <Card key={line.lineKey}>
          <CardHeader>
            <HStack className="justify-between">
              <CardTitle>{t`Line ${index + 1}`}</CardTitle>
              <Badge>{statusLabel(line.review.origin)}</Badge>
            </HStack>
            {typeof line.raw.sourceText === "string" && (
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                {line.raw.sourceText}
              </p>
            )}
            {line.review.matchReason && (
              <p className="text-sm text-muted-foreground">
                {line.review.matchReason}
              </p>
            )}
          </CardHeader>
          {modelSuggestions
            .filter((suggestion) => suggestion.lineKey === line.lineKey)
            .map((suggestion) => (
              <div key={suggestion.lineKey} className="px-6 pb-3 space-y-2">
                <p className="text-sm">
                  <Trans>Model suggestion:</Trans>{" "}
                  {suggestion.itemId
                    ? (items.find((item) => item.id === suggestion.itemId)
                        ?.name ?? t`Unavailable item`)
                    : suggestion.suggestedType}{" "}
                  · {suggestion.reason}
                </p>
                <Button
                  variant="secondary"
                  isDisabled={
                    readOnly ||
                    (!suggestion.itemId && !suggestion.suggestedType)
                  }
                  onClick={() => {
                    const item = items.find(
                      (item) => item.id === suggestion.itemId
                    );
                    patch(line.lineKey, {
                      itemId: item?.id ?? null,
                      newItem: null,
                      lineType:
                        item &&
                        invoiceItemTypes.includes(item.type as InvoiceItemType)
                          ? (item.type as InvoiceItemType)
                          : suggestion.suggestedType,
                      stockUnit: item?.unitOfMeasureCode ?? null,
                      conversionFactor: null,
                      review: {
                        ...line.review,
                        origin: "model",
                        matchReason: suggestion.reason
                      }
                    });
                  }}
                >
                  <Trans>Use suggestion and review units</Trans>
                </Button>
              </div>
            ))}
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <InvoiceTextField
                label={t`Description`}
                value={line.description}
                onChange={(description) => patch(line.lineKey, { description })}
                disabled={readOnly}
              />
              <InvoiceChoiceField
                label={t`Line type`}
                value={line.lineType}
                options={invoiceLineTypes.map((value) => ({
                  value,
                  label: value
                }))}
                onChange={(type) =>
                  patch(line.lineKey, {
                    lineType: type as InvoiceIntakeReviewLine["lineType"],
                    itemId: null,
                    newItem: null,
                    accountId: null,
                    assetId: null
                  })
                }
                disabled={readOnly}
              />
              <InvoiceTextField
                label={t`Supplier SKU`}
                value={line.supplierSku}
                onChange={(supplierSku) => patch(line.lineKey, { supplierSku })}
                disabled={readOnly}
              />
              <InvoiceTextField
                label={t`Manufacturer part number`}
                value={line.manufacturerPartNumber}
                onChange={(manufacturerPartNumber) =>
                  patch(line.lineKey, { manufacturerPartNumber })
                }
                disabled={readOnly}
              />
            </div>
            {invoiceItemTypes.includes(line.lineType as InvoiceItemType) && (
              <div className="space-y-3">
                <InvoiceChoiceField
                  label={t`Existing item`}
                  value={line.itemId}
                  options={items
                    .filter(
                      (item) => item.active && item.type === line.lineType
                    )
                    .map((item) => ({
                      value: item.id,
                      label: `${item.readableId} — ${item.name}`
                    }))}
                  disabled={readOnly}
                  onChange={(itemId) => {
                    const item = items.find((item) => item.id === itemId);
                    patch(line.lineKey, {
                      itemId,
                      newItem: null,
                      lineType:
                        item?.type === "Fixture"
                          ? null
                          : ((item?.type ??
                              line.lineType) as InvoiceItemType | null),
                      stockUnit: item?.unitOfMeasureCode ?? null,
                      conversionFactor:
                        item && item.unitOfMeasureCode === line.purchaseUnit
                          ? "1"
                          : null
                    });
                  }}
                />
                {line.newItem && (
                  <p className="text-sm">
                    <Trans>New item proposed:</Trans>{" "}
                    {String(line.newItem.data.name ?? "")} ({line.newItem.type})
                  </p>
                )}
                <Button
                  variant="secondary"
                  isDisabled={
                    readOnly ||
                    !canCreateTypes.includes(line.lineType as InvoiceItemType)
                  }
                  onClick={() => setProposing(line.lineKey)}
                >
                  {line.newItem ? t`Edit item proposal` : t`Propose new item`}
                </Button>
              </div>
            )}
            {line.lineType === "G/L Account" && (
              <InvoiceChoiceField
                label={t`Expense account`}
                value={line.accountId}
                options={accounts}
                onChange={(accountId) => patch(line.lineKey, { accountId })}
                disabled={readOnly}
              />
            )}
            {line.lineType === "Fixed Asset" && (
              <InvoiceChoiceField
                label={t`Fixed asset`}
                value={line.assetId}
                options={assets}
                onChange={(assetId) => patch(line.lineKey, { assetId })}
                disabled={readOnly}
              />
            )}
            <div className="grid gap-4 md:grid-cols-3">
              <InvoiceDecimalField
                label={t`Quantity purchased`}
                value={line.quantity}
                onChange={(quantity) => patch(line.lineKey, { quantity })}
                disabled={readOnly}
              />
              <InvoiceDecimalField
                label={t`Net unit price`}
                value={line.supplierUnitPrice}
                onChange={(supplierUnitPrice) =>
                  patch(line.lineKey, { supplierUnitPrice })
                }
                disabled={readOnly}
              />
              <InvoiceDecimalField
                label={t`Source line total`}
                value={line.documentLineTotal}
                onChange={(documentLineTotal) =>
                  patch(line.lineKey, { documentLineTotal })
                }
                disabled={readOnly}
              />
              <InvoiceChoiceField
                label={t`Purchase unit`}
                value={line.purchaseUnit}
                options={units}
                onChange={(purchaseUnit) =>
                  patch(line.lineKey, {
                    purchaseUnit,
                    conversionFactor:
                      purchaseUnit === line.stockUnit ? "1" : null
                  })
                }
                disabled={readOnly}
              />
              <InvoiceChoiceField
                label={t`Inventory unit`}
                value={line.stockUnit}
                options={units}
                onChange={(stockUnit) =>
                  patch(line.lineKey, {
                    stockUnit,
                    conversionFactor:
                      stockUnit === line.purchaseUnit ? "1" : null
                  })
                }
                disabled={readOnly || Boolean(line.itemId)}
              />
              <InvoiceDecimalField
                label={t`Inventory units per purchase unit`}
                value={line.conversionFactor}
                onChange={(conversionFactor) =>
                  patch(line.lineKey, { conversionFactor })
                }
                disabled={readOnly}
              />
              <InvoiceDecimalField
                label={t`Discount included in net price`}
                value={line.discountAmount}
                onChange={(discountAmount) =>
                  patch(line.lineKey, { discountAmount })
                }
                disabled={readOnly}
              />
              <InvoiceDecimalField
                label={t`Line tax amount`}
                value={line.supplierTaxAmount}
                onChange={(supplierTaxAmount) =>
                  patch(line.lineKey, { supplierTaxAmount })
                }
                disabled={readOnly}
              />
              <InvoiceDecimalField
                label={t`Tax percent`}
                formatOptions={INPUT_FORMAT.percent}
                value={line.taxPercent}
                onChange={(taxPercent) => patch(line.lineKey, { taxPercent })}
                disabled={readOnly}
              />
              <InvoiceDecimalField
                label={t`Line shipping`}
                value={line.supplierShippingCost}
                onChange={(supplierShippingCost) =>
                  patch(line.lineKey, { supplierShippingCost })
                }
                disabled={readOnly}
              />
              <InvoiceChoiceField
                label={t`Inventory location`}
                value={line.locationId}
                options={locations}
                onChange={(locationId) =>
                  patch(line.lineKey, { locationId, storageUnitId: null })
                }
                disabled={readOnly}
              />
              {invoiceLines.length > 0 && (
                <InvoiceChoiceField
                  label={t`Replace this reviewed draft line`}
                  value={line.purchaseInvoiceLineId}
                  options={invoiceLines}
                  onChange={(purchaseInvoiceLineId) =>
                    patch(line.lineKey, {
                      purchaseInvoiceLineId,
                      review: {
                        ...line.review,
                        expectedInvoiceLineUpdatedAt:
                          invoiceLines.find(
                            (option) => option.value === purchaseInvoiceLineId
                          )?.updatedAt ?? null
                      }
                    })
                  }
                  disabled={readOnly}
                />
              )}
            </div>
            {line.discountAmount && Number(line.discountAmount) > 0 && (
              <InvoiceToggle
                label={t`The net unit price includes this discount`}
                checked={line.review.discountIncludedInPrice}
                onChange={(discountIncludedInPrice) =>
                  patch(line.lineKey, {
                    review: { ...line.review, discountIncludedInPrice }
                  })
                }
                disabled={readOnly}
              />
            )}
            {line.lineType === "Comment" && (
              <InvoiceToggle
                label={t`This is a nonfinancial comment in the source`}
                checked={line.review.commentConfirmed}
                onChange={(commentConfirmed) =>
                  patch(line.lineKey, {
                    review: { ...line.review, commentConfirmed }
                  })
                }
                disabled={readOnly}
              />
            )}
            <InvoiceToggle
              label={t`Remember this supplier item and pack match after approval`}
              checked={canRemember && line.review.rememberMatch}
              onChange={(rememberMatch) =>
                patch(line.lineKey, {
                  review: { ...line.review, rememberMatch }
                })
              }
              disabled={readOnly || !canRemember}
            />
            {canRemember && canReplaceRule && recognitionRules.length > 0 && (
              <>
                <InvoiceChoiceField
                  label={t`Saved item rule to correct`}
                  value={line.review.replaceRuleId}
                  options={recognitionRules}
                  onChange={(replaceRuleId) =>
                    patch(line.lineKey, {
                      review: { ...line.review, replaceRuleId }
                    })
                  }
                  disabled={readOnly}
                />
                {line.review.replaceRuleId && (
                  <InvoiceTextField
                    label={t`Reason for replacing this item match`}
                    value={line.review.replacementReason}
                    onChange={(replacementReason) =>
                      patch(line.lineKey, {
                        review: { ...line.review, replacementReason }
                      })
                    }
                    disabled={readOnly}
                  />
                )}
              </>
            )}
            <InvoiceTextField
              label={t`Reason to exclude this source line`}
              value={exclusionReasons[line.lineKey] ?? null}
              onChange={(reason) =>
                setExclusionReasons((previous) => ({
                  ...previous,
                  [line.lineKey]: reason ?? ""
                }))
              }
              disabled={readOnly}
            />
            <Button
              variant="ghost"
              isDisabled={readOnly || !exclusionReasons[line.lineKey]?.trim()}
              onClick={() =>
                onExclude(line.lineKey, exclusionReasons[line.lineKey])
              }
            >
              <Trans>Remove line from review</Trans>
            </Button>
          </CardContent>
        </Card>
      ))}
      <Button
        variant="secondary"
        isDisabled={readOnly}
        onClick={() =>
          onChange([
            ...lines,
            invoiceIntakeLineValidator.parse({
              lineKey: crypto.randomUUID(),
              sortOrder: lines.length
            })
          ])
        }
      >
        <Trans>Add line</Trans>
      </Button>
      {proposalLine && (
        <DeferredMasterCreation.Provider value={true}>
          <InvoiceItemProposal
            line={proposalLine}
            units={units}
            onClose={() => setProposing(null)}
            onUse={(proposal) => {
              const priorKey = proposalLine.newItem
                ? invoiceProposalKey(proposalLine.newItem)
                : null;
              onChange(
                lines.map((line) =>
                  line.lineKey === proposalLine.lineKey ||
                  (priorKey &&
                    line.newItem &&
                    invoiceProposalKey(line.newItem) === priorKey)
                    ? {
                        ...line,
                        itemId: null,
                        newItem: proposal,
                        lineType: proposal.type,
                        stockUnit:
                          String(proposal.data.unitOfMeasureCode ?? "") || null,
                        conversionFactor:
                          proposal.data.unitOfMeasureCode &&
                          proposal.data.unitOfMeasureCode === line.purchaseUnit
                            ? "1"
                            : null
                      }
                    : line
                )
              );
            }}
          />
        </DeferredMasterCreation.Provider>
      )}
    </div>
  );
}
