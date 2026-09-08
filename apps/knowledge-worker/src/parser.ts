import { createServiceAuthorizationHeader } from "@carbon/knowledge/identity.server";
import { createExtraction, type ParserOutput } from "@carbon/knowledge/intake";
import type { Storage } from "@google-cloud/storage";
import {
  captureExistingObject,
  type ImmutableObjectReference,
  readImmutableObject
} from "./gcs";

export function parseCapturedDocument(output: ParserOutput) {
  return createExtraction(output);
}

export async function invokeIsolatedParser(
  reference: ImmutableObjectReference,
  mimeType: string,
  options: {
    parserUrl: string;
    parserAudience?: string;
    authorizationHeader?: () => Promise<string>;
    outputObjectKey?: string;
    storage?: Storage;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }
): Promise<ReturnType<typeof createExtraction>> {
  const parserUrl = new URL(options.parserUrl);
  if (parserUrl.protocol !== "https:")
    throw new Error("isolated parser URL must use HTTPS");
  const authorization = await (
    options.authorizationHeader ??
    (() =>
      createServiceAuthorizationHeader(
        options.parserAudience ?? parserUrl.origin
      ))
  )();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(Math.max(options.timeoutMs ?? 120_000, 1_000), 300_000)
  );
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(parserUrl, {
      method: "POST",
      signal: controller.signal,
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        input: {
          bucket: reference.bucket,
          objectKey: reference.objectKey,
          generation: reference.generation,
          sha256: reference.sha256
        },
        outputObjectKey:
          options.outputObjectKey ?? `${reference.objectKey}.extraction.json`,
        mimeType,
        limits: {
          pages: 2_000,
          outputBytes: 8_000_000,
          evidenceCharacters: 8_000
        }
      })
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok)
    throw new Error(`isolated parser failed (${response.status})`);
  const envelope = (await response.json()) as {
    output?: ImmutableObjectReference;
  };
  if (!envelope.output)
    throw new Error("isolated parser returned no immutable output reference");
  const outputBytes = await readImmutableObject(
    { ...envelope.output, maxBytes: 8_000_000 },
    options.storage
  );
  let parsed: ParserOutput;
  try {
    parsed = JSON.parse(outputBytes.toString("utf8")) as ParserOutput;
  } catch {
    throw new Error("isolated parser returned invalid JSON");
  }
  return createExtraction(parsed);
}

async function metadataAccessToken(fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } }
  );
  if (!response.ok)
    throw new Error("Cloud Run job authorization is unavailable");
  const body = (await response.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string" || !body.access_token)
    throw new Error("Cloud Run job authorization is unavailable");
  return body.access_token;
}

export async function invokeCloudRunParserJob(
  reference: ImmutableObjectReference,
  mimeType: string,
  options: {
    project: string;
    location: string;
    job: string;
    outputBucket: string;
    storage?: Storage;
    fetchImpl?: typeof fetch;
    accessToken?: () => Promise<string>;
    wait?: (milliseconds: number) => Promise<void>;
    maximumPolls?: number;
  }
): Promise<ReturnType<typeof createExtraction>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = await (
    options.accessToken ?? (() => metadataAccessToken(fetchImpl))
  )();
  const outputObjectKey = `parser/${reference.sha256}/extraction-v1.json`;
  const jobName = `projects/${encodeURIComponent(options.project)}/locations/${encodeURIComponent(options.location)}/jobs/${encodeURIComponent(options.job)}`;
  const response = await fetchImpl(
    `https://run.googleapis.com/v2/${jobName}:run`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        overrides: {
          taskCount: 1,
          timeout: "300s",
          containerOverrides: [
            {
              env: [
                {
                  name: "KNOWLEDGE_PARSER_INPUT_JSON",
                  value: JSON.stringify({
                    bucket: reference.bucket,
                    objectKey: reference.objectKey,
                    generation: reference.generation,
                    sha256: reference.sha256,
                    mimeType
                  })
                },
                {
                  name: "KNOWLEDGE_PARSER_OUTPUT_JSON",
                  value: JSON.stringify({
                    bucket: options.outputBucket,
                    objectKey: outputObjectKey
                  })
                }
              ]
            }
          ]
        }
      })
    }
  );
  if (!response.ok)
    throw new Error(
      `Cloud Run parser job failed to start (${response.status})`
    );
  const operation = (await response.json()) as {
    name?: string;
    done?: boolean;
    error?: unknown;
  };
  if (!operation.name)
    throw new Error("Cloud Run parser job returned no operation");
  let state = operation;
  const wait =
    options.wait ??
    ((milliseconds) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (
    let poll = 0;
    !state.done && poll < (options.maximumPolls ?? 150);
    poll += 1
  ) {
    await wait(2_000);
    const status = await fetchImpl(
      `https://run.googleapis.com/v2/${state.name}`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    if (!status.ok)
      throw new Error(`Cloud Run parser operation failed (${status.status})`);
    state = (await status.json()) as typeof state;
  }
  if (!state.done || state.error)
    throw new Error("Cloud Run parser job did not complete successfully");
  const output = await captureExistingObject(
    options.outputBucket,
    outputObjectKey,
    8_000_000,
    options.storage
  );
  const outputBytes = await readImmutableObject(output, options.storage);
  try {
    return createExtraction(
      JSON.parse(outputBytes.toString("utf8")) as ParserOutput
    );
  } catch {
    throw new Error("Cloud Run parser output is invalid");
  }
}
