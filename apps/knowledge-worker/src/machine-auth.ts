/**
 * Machine admission moved to `@carbon/knowledge/machine-identity.server` so the
 * Carbon source-changes receiver verifies the same registration shape with the
 * same rules. This module keeps the worker's import path stable.
 */
export {
  type MachineCallerConfiguration,
  type MachineCapability,
  type MachinePrincipal,
  parseMachineCallerConfiguration,
  verifyMachineRequest
} from "@carbon/knowledge/machine-identity.server";
