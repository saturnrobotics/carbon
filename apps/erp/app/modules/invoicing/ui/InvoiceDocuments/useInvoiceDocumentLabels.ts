import { useLingui } from "@lingui/react/macro";

export function useInvoiceDocumentLabels() {
  const { t } = useLingui();
  const labels: Record<string, string> = {
    NeedsDocument: t`Needs document`,
    Queued: t`Queued`,
    Processing: t`Processing`,
    NeedsReview: t`Needs review`,
    Ready: t`Ready`,
    Approved: t`Approved`,
    Linked: t`Linked`,
    Ignored: t`Ignored`,
    Failed: t`Failed`,
    Idle: t`Not started`,
    Running: t`Running`,
    Paused: t`Paused`,
    Completed: t`Completed`,
    document: t`From document`,
    savedMatch: t`Saved match`,
    catalog: t`Catalog suggestion`,
    model: t`Model suggestion`,
    manual: t`Manual correction`
  };
  return (key: string) => labels[key] ?? key;
}
