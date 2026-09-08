import { useState } from "react";

export function IntakeUpload({
  sourceDisplayName
}: {
  sourceDisplayName: string;
}) {
  const [message, setMessage] = useState("");
  return (
    <form
      method="post"
      encType="multipart/form-data"
      onSubmit={() => {
        setMessage("The manual is queued for extraction.");
      }}
    >
      <label>
        Manual file{" "}
        <input
          name="document"
          type="file"
          required
          accept="application/pdf,image/png,image/jpeg,image/tiff"
          aria-describedby="intake-help"
        />
      </label>
      <p id="intake-help">
        PDF and image files are captured with their immutable object version
        before extraction.
      </p>
      <p>
        Library: <strong>{sourceDisplayName}</strong>
      </p>
      <button type="submit">Upload manual</button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
