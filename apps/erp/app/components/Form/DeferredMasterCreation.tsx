import { createContext, useContext } from "react";

/** Proposal forms may select existing definitions, but cannot create nested
 * master records before their enclosing document is approved. */
export const DeferredMasterCreation = createContext(false);
export const useDeferredMasterCreation = () =>
  useContext(DeferredMasterCreation);
