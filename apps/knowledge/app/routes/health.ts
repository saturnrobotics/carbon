import { readManualSourceConfiguration } from "@carbon/knowledge/release-profile";

const required = [
  "KNOWLEDGE_COMPANY_ID",
  "KNOWLEDGE_QUERY_AUDIENCE",
  "KNOWLEDGE_QUERY_URL",
  "KNOWLEDGE_WEB_IAP_AUDIENCE",
  "KNOWLEDGE_WEB_ORIGIN",
  "KNOWLEDGE_WORKER_AUDIENCE",
  "KNOWLEDGE_WORKER_URL"
] as const;

export function isKnowledgeWebReady(environment: NodeJS.ProcessEnv): boolean {
  if (!required.every((key) => environment[key]?.trim())) return false;
  try {
    readManualSourceConfiguration(environment);
    return true;
  } catch {
    return false;
  }
}

export function loader() {
  const ready = isKnowledgeWebReady(process.env);
  return Response.json(
    { status: ready ? "ok" : "not-configured", service: "knowledge-web" },
    { status: ready ? 200 : 503 }
  );
}
