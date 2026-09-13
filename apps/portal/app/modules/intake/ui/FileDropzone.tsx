import { useLingui } from "@lingui/react/macro";
import {
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
  useId,
  useRef,
  useState
} from "react";

/**
 * Drag-and-drop wrapper around a real `<input type="file">` that stays in the
 * form, so a plain (unhydrated) submission and keyboard users both work. The
 * ERP `FileDropzone` is built on `react-dropzone`; this portal deliberately
 * keeps no shared UI dependency, so the same behaviour is a few native events.
 */
export function FileDropzone({
  name,
  label,
  accept,
  describedBy,
  disabled,
  onFileChange,
  children
}: {
  name: string;
  label: ReactNode;
  accept: string;
  describedBy?: string;
  disabled?: boolean;
  onFileChange: (file: File | null) => void;
  children?: ReactNode;
}) {
  const { t } = useLingui();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string>();
  const inputId = useId();

  function announce(file: File | null) {
    setFileName(file?.name);
    onFileChange(file);
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const file = event.dataTransfer.files.item(0);
    if (!file || !input.current) return;
    // Place the dropped file in the form's own input so it is submitted like a
    // chosen one and nothing is uploaded outside the multipart request.
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.current.files = transfer.files;
    announce(file);
  }

  function change(event: ChangeEvent<HTMLInputElement>) {
    announce(event.target.files?.item(0) ?? null);
  }

  return (
    <div
      className={`dropzone${dragging ? " dropzone-active" : ""}${disabled ? " dropzone-disabled" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setDragging(false);
      }}
      onDrop={drop}
    >
      <label className="dropzone-label" htmlFor={inputId}>
        {label}
      </label>
      <input
        accept={accept}
        aria-describedby={describedBy}
        disabled={disabled}
        id={inputId}
        name={name}
        onChange={change}
        ref={input}
        type="file"
      />
      <p className="dropzone-hint">
        {fileName
          ? t`Selected: ${fileName}`
          : t`Drag and drop a PDF or image here, or choose a file.`}
      </p>
      {children}
    </div>
  );
}
