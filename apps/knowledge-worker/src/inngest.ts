import { Inngest } from "inngest";

/** Separate application: worker deployments never register Carbon's ERP function list. */
export const knowledgeInngest = new Inngest({ id: "knowledge-worker" });
