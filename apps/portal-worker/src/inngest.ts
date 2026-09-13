import { Inngest } from "inngest";

/** Separate application: worker deployments never register Carbon's ERP function list. */
export const portalInngest = new Inngest({ id: "portal-worker" });
