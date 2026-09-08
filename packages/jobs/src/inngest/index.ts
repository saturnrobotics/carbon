// Must load before any function module pulls in pdfjs (extract-document), whose
// init runs `new DOMMatrix()` — undefined in the Node worker without this shim.
import "@carbon/lib/shims";

// Re-export the inngest client and helpers

export {
  type InvoiceIntakeValidationContext,
  setInvoiceIntakeValidation
} from "../invoice-intake/validation.ts";
export type {
  ProcurementScheduleDispatch,
  ProcurementScheduleDispatchContext
} from "../procurement-schedule/dispatcher.ts";
export { setProcurementScheduleDispatch } from "../procurement-schedule/dispatcher.ts";
// Server-only on purpose: the app bundle imports `@carbon/jobs`, not this subpath.
export type {
  DispatchContext,
  DispatchResult,
  WorkflowDispatch
} from "../workflows/actions/dispatcher.ts";
export { setWorkflowDispatch } from "../workflows/actions/dispatcher.ts";
export type { ManualRunResult } from "../workflows/engine/index.ts";
export {
  executeManualWorkflowRun,
  noAccess
} from "../workflows/engine/index.ts";
export { inngest } from "./client.ts";

import {
  auditFunction,
  embeddingFunction,
  eventQueueFunction,
  searchFunction,
  syncFunction,
  webhookFunction,
  workflowFunction
} from "./functions/events";
import { extractDocumentFunction } from "./functions/extraction";
import {
  invoiceIntakeAttachmentFunction,
  invoiceIntakeBackfillFunction,
  invoiceIntakeFunction,
  invoiceIntakeMatchFunction,
  invoiceIntakeReconcileFunction,
  invoiceIntakeSourceRecoveryFunction,
  invoiceIntakeValidationFunction
} from "./functions/extraction/invoice-intake";
import {
  accountingBackfillFunction,
  accountingConsolidationFunction,
  accountingOutboundSweepFunction,
  accountingPullSweepFunction,
  accountingReconciliationFunction,
  jiraSyncFunction,
  linearSyncFunction,
  onshapeBackfillFunction,
  onshapeRevisionSyncFunction,
  paperlessPartsFunction,
  slackDocumentAssignmentUpdateFunction,
  slackDocumentCreatedFunction,
  slackDocumentStatusUpdateFunction,
  slackDocumentTaskUpdateFunction,
  stripeConnectPullSweepFunction,
  syncExternalAccountingFunction,
  timeCardAutoCloseFunction
} from "./functions/integrations";
import { mercurySyncFunction } from "./functions/integrations/mercury-sync";
// Import all functions
import {
  notifyFunction,
  sendEmailFunction,
  sendSlackFunction
} from "./functions/notifications";
import {
  auditArchiveFunction,
  cleanupFunction,
  dispatchFunction,
  generateMaintenanceForScheduleFunction,
  markScheduleStaleFunction,
  mrpFunction,
  nightlyReplanFunction,
  notificationDigestFunction,
  notificationPurgeFunction,
  procurementScheduleExecuteFunction,
  procurementScheduleSweepFunction,
  scheduleReplanWaveFunction,
  updateExchangeRatesFunction,
  weeklyFunction,
  workflowRunRetentionFunction
} from "./functions/scheduled";
import {
  assemblyConvertFunction,
  assemblyPlanFunction,
  companyExportFunction,
  companyImportFunction,
  companyRestoreFinalizeFunction,
  companyRestoreFunction,
  companyRestoreRevertFunction,
  companyTemplateFinalizeFunction,
  companyTemplateFunction,
  companyTemplateRevertFunction,
  modelCompactFunction,
  modelOptimizeFunction,
  modelThumbnailFunction,
  onboardFunction,
  postTransactionFunction,
  printJobDeliverFunction,
  printJobFunction,
  recalculateFunction,
  updatePermissionsFunction,
  userAdminFunction
} from "./functions/tasks";
import {
  workflowMomentFunction,
  workflowRunFunction,
  workflowSchedulerBackstopFunction,
  workflowSchedulerFunction
} from "./functions/workflows";

// Export all functions for serving via serve() or connect()
export const functions = [
  // Notifications
  notifyFunction,
  sendEmailFunction,
  sendSlackFunction,
  // Event handlers
  auditFunction,
  eventQueueFunction,
  searchFunction,
  syncFunction,
  webhookFunction,
  workflowFunction,
  embeddingFunction,
  // Workflows
  workflowMomentFunction,
  workflowRunFunction,
  workflowSchedulerFunction,
  workflowSchedulerBackstopFunction,
  // Tasks
  assemblyConvertFunction,
  assemblyPlanFunction,
  companyExportFunction,
  companyImportFunction,
  companyRestoreFunction,
  companyRestoreFinalizeFunction,
  companyRestoreRevertFunction,
  companyTemplateFinalizeFunction,
  companyTemplateFunction,
  companyTemplateRevertFunction,
  modelCompactFunction,
  modelOptimizeFunction,
  modelThumbnailFunction,
  updatePermissionsFunction,
  recalculateFunction,
  userAdminFunction,
  postTransactionFunction,
  onboardFunction,
  printJobFunction,
  printJobDeliverFunction,
  // Scheduled
  cleanupFunction,
  dispatchFunction,
  generateMaintenanceForScheduleFunction,
  auditArchiveFunction,
  mrpFunction,
  markScheduleStaleFunction,
  nightlyReplanFunction,
  scheduleReplanWaveFunction,
  weeklyFunction,
  updateExchangeRatesFunction,
  notificationDigestFunction,
  notificationPurgeFunction,
  procurementScheduleExecuteFunction,
  procurementScheduleSweepFunction,
  workflowRunRetentionFunction,
  // Integrations
  mercurySyncFunction,
  jiraSyncFunction,
  linearSyncFunction,
  paperlessPartsFunction,
  accountingBackfillFunction,
  accountingConsolidationFunction,
  accountingOutboundSweepFunction,
  accountingReconciliationFunction,
  accountingPullSweepFunction,
  onshapeBackfillFunction,
  onshapeRevisionSyncFunction,
  syncExternalAccountingFunction,
  slackDocumentCreatedFunction,
  slackDocumentStatusUpdateFunction,
  slackDocumentTaskUpdateFunction,
  slackDocumentAssignmentUpdateFunction,
  stripeConnectPullSweepFunction,
  timeCardAutoCloseFunction,
  // Document extraction
  extractDocumentFunction,
  invoiceIntakeValidationFunction,
  invoiceIntakeAttachmentFunction,
  invoiceIntakeBackfillFunction,
  invoiceIntakeFunction,
  invoiceIntakeMatchFunction,
  invoiceIntakeReconcileFunction,
  invoiceIntakeSourceRecoveryFunction
];
