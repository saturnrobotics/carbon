import type { WritableIntakeSources } from "@carbon/knowledge";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";
import { FileDropzone } from "./FileDropzone";

type Source = WritableIntakeSources["sources"][number];

export function IntakeUpload({
  actorId,
  sources,
  error
}: {
  actorId: string;
  sources: Source[];
  /** Worker error code from the last attempt, shown apart from extraction. */
  error?: string;
}) {
  const { t } = useLingui();
  const [message, setMessage] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const helpId = useId();
  const cameraId = useId();
  const urlId = useId();
  const libraryId = useId();
  const [sourceId, setSourceId] = useState(sources[0]?.sourceId ?? "");
  const selected = sources.find((source) => source.sourceId === sourceId);
  // The server is the gate: the button stays enabled so an unhydrated form
  // still posts, and a refused attempt is reported inline below.
  const hasFile = Boolean(file || photo);
  const hasUrl = url.trim().length > 0;

  const errors: Record<string, string> = {
    acquisition_failed: t`The document could not be fetched from that address. Check that it is a public HTTPS link to a PDF or image, or upload the file instead.`,
    invalid_request: t`Choose one PDF, image, photo, or HTTPS address.`,
    unauthorized: t`You are not allowed to add documents to this library.`,
    forbidden: t`You are not allowed to add documents to the selected library.`,
    service_unavailable: t`The upload service is unavailable. The document was not captured.`
  };

  return (
    <form
      className="intake-form"
      encType="multipart/form-data"
      method="post"
      onSubmit={() => {
        setMessage(t`The document is queued for extraction.`);
      }}
    >
      <fieldset className="intake-fieldset">
        <legend>
          <Trans>Document</Trans>
        </legend>
        <FileDropzone
          accept="application/pdf,image/png,image/jpeg,image/tiff"
          describedBy={helpId}
          disabled={hasUrl}
          label={t`Manual file`}
          name="document"
          onFileChange={setFile}
        />
        <p id={helpId}>
          <Trans>
            PDF and image files are captured with their immutable object version
            before extraction.
          </Trans>
        </p>
        <div className="intake-alternatives">
          <label htmlFor={cameraId}>
            <Trans>Take a photo of a nameplate or label</Trans>
          </label>
          <input
            accept="image/*"
            capture="environment"
            disabled={hasUrl}
            id={cameraId}
            name="photo"
            onChange={(event) => setPhoto(event.target.files?.item(0) ?? null)}
            type="file"
          />
          <label htmlFor={urlId}>
            <Trans>Source URL</Trans>
          </label>
          <input
            disabled={hasFile}
            id={urlId}
            inputMode="url"
            maxLength={2048}
            name="sourceUrl"
            onChange={(event) => setUrl(event.target.value)}
            pattern="https://.*"
            placeholder="https://"
            type="url"
            value={url}
          />
          <p>
            <Trans>
              Only public HTTPS addresses are fetched, through the server's
              fetch policy, and the fetched copy is stored immutably.
            </Trans>
          </p>
        </div>
      </fieldset>

      <fieldset className="intake-fieldset">
        <legend>
          <Trans>Library and access</Trans>
        </legend>
        {sources.length === 0 ? (
          <p role="alert">
            <Trans>
              You cannot add documents to any library. Ask an administrator for
              a library grant.
            </Trans>
          </p>
        ) : (
          <>
            <label htmlFor={libraryId}>
              <Trans>Library</Trans>
            </label>
            <select
              id={libraryId}
              name="sourceId"
              onChange={(event) => setSourceId(event.target.value)}
              value={sourceId}
            >
              {sources.map((source) => (
                <option key={source.sourceId} value={source.sourceId}>
                  {source.displayName}
                </option>
              ))}
            </select>
            <p>
              <Trans>
                Owner: {actorId}. Access: {selected?.classification ?? ""}.
                Readers of this library can find the document once it is
                reviewed and published.
              </Trans>
            </p>
          </>
        )}
      </fieldset>

      {hasFile && hasUrl ? (
        <p role="alert">
          <Trans>Choose either a file or a URL, not both.</Trans>
        </p>
      ) : null}
      <button type="submit">
        <Trans>Upload manual</Trans>
      </button>
      {error ? (
        <p role="alert">{errors[error] ?? errors.service_unavailable}</p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}
