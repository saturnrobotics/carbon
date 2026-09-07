import {
  Button,
  Modal,
  ModalBody,
  ModalClose,
  ModalContent,
  ModalHeader,
  ModalOverlay
} from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect } from "react";
import { Link, useFetcher } from "react-router";
import { PdfExtractor } from "~/components/Form/PdfExtractor";
import { path } from "~/utils/path";

export type MapExtractedInvoiceLinesModalProps = {
  invoiceId: string;
  supplierId: string | undefined;
  onClose: () => void;
};
export default function MapExtractedInvoiceLinesModal({
  invoiceId,
  onClose
}: MapExtractedInvoiceLinesModalProps) {
  const { t } = useLingui();
  const fetcher = useFetcher<{ intakeId: string | null }>();
  useEffect(() => {
    if (fetcher.state === "idle" && !fetcher.data)
      fetcher.load(`/api/purchase-invoice/${invoiceId}/map-lines`);
  }, [fetcher, invoiceId]);
  return (
    <Modal open onOpenChange={(open) => !open && onClose()}>
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>
          <Trans>Review invoice document</Trans>
          <ModalClose />
        </ModalHeader>
        <ModalBody className="space-y-4">
          <p>
            <Trans>
              Review the original invoice to select the correct supplier and
              item classes, confirm pack sizes and totals, and map each existing
              line explicitly.
            </Trans>
          </p>
          {fetcher.data?.intakeId && (
            <Button asChild>
              <Link to={path.to.invoiceDocument(fetcher.data.intakeId)}>
                <Trans>Open document review</Trans>
              </Link>
            </Button>
          )}
          <PdfExtractor
            documentType="purchaseInvoice"
            sourceDocument="Purchase Invoice"
            sourceDocumentId={invoiceId}
            label={t`Invoice`}
          />
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
