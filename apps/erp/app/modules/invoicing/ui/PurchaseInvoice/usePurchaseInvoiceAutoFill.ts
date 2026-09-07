import { useCarbon } from "@carbon/auth";
import { toast } from "@carbon/react";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { flushSync } from "react-dom";
import type { z } from "zod";
import { useUser } from "~/hooks";
import type { purchaseInvoiceValidator } from "~/modules/invoicing";

type PurchaseInvoiceFormValues = z.infer<typeof purchaseInvoiceValidator>;

type InvoiceSupplierState = {
  id: string | undefined;
  invoiceSupplierContactId: string | undefined;
  invoiceSupplierLocationId: string | undefined;
  currencyCode: string | undefined;
  paymentTermId: string | undefined;
};

/**
 * Resolves the native invoice form defaults when its supplier changes.
 * Document extraction is reviewed independently in the invoice document inbox.
 */
export function usePurchaseInvoiceAutoFill(
  initialValues: PurchaseInvoiceFormValues
) {
  const { t } = useLingui();
  const { carbon } = useCarbon();
  const { company } = useUser();

  const [invoiceSupplier, setInvoiceSupplier] = useState<InvoiceSupplierState>({
    id: initialValues.invoiceSupplierId,
    invoiceSupplierContactId: initialValues.invoiceSupplierContactId,
    invoiceSupplierLocationId: initialValues.invoiceSupplierLocationId,
    currencyCode: initialValues.currencyCode,
    paymentTermId: initialValues.paymentTermId
  });
  const [supplier, setSupplier] = useState<{ id: string | undefined }>({
    id: initialValues.supplierId
  });

  const onSupplierChange = async (
    newValue: { value: string | undefined } | null
  ) => {
    setSupplier({ id: newValue?.value });
    if (newValue?.value !== invoiceSupplier.id) {
      onInvoiceSupplierChange(newValue);
    }
  };

  const onInvoiceSupplierChange = async (
    newValue: { value: string | undefined } | null
  ) => {
    if (!carbon) {
      toast.error(t`Carbon client not found`);
      return;
    }

    if (newValue?.value) {
      flushSync(() => {
        // update the supplier immediately
        setInvoiceSupplier({
          id: newValue?.value,
          currencyCode: undefined,
          paymentTermId: undefined,
          invoiceSupplierContactId: undefined,
          invoiceSupplierLocationId: undefined
        });
      });

      const [supplierData, paymentTermData] = await Promise.all([
        carbon
          .from("supplier")
          .select(
            "currencyCode, purchasingContactId, supplierShipping!supplierShipping_supplierId_fkey(shippingSupplierLocationId)"
          )
          .eq("id", newValue.value)
          .eq("companyId", company.id)
          .single(),
        carbon
          .from("supplierPayment")
          .select("*")
          .eq("supplierId", newValue.value)
          .eq("companyId", company.id)
          .single()
      ]);

      if (supplierData.error || paymentTermData.error) {
        toast.error(t`Error fetching supplier data`);
      } else {
        setInvoiceSupplier((prev) => ({
          ...prev,
          id: newValue.value,
          invoiceSupplierContactId:
            paymentTermData.data.invoiceSupplierContactId ??
            supplierData.data.purchasingContactId ??
            undefined,
          invoiceSupplierLocationId:
            paymentTermData.data.invoiceSupplierLocationId ??
            supplierData.data.supplierShipping?.[0]
              ?.shippingSupplierLocationId ??
            undefined,
          currencyCode: supplierData.data.currencyCode ?? undefined,
          paymentTermId: paymentTermData.data.paymentTermId ?? undefined
        }));
      }
    } else {
      setInvoiceSupplier({
        id: undefined,
        currencyCode: undefined,
        paymentTermId: undefined,
        invoiceSupplierContactId: undefined,
        invoiceSupplierLocationId: undefined
      });
    }
  };

  return {
    currentValues: initialValues,
    supplier,
    invoiceSupplier,
    setInvoiceSupplier,
    onSupplierChange,
    onInvoiceSupplierChange
  };
}
