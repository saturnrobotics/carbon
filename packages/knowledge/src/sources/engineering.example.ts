import { now } from "@internationalized/date";
import { genericSourceDescriptor } from "./generic.server";
import {
  createSyntheticProducer,
  type SourceEntity,
  type SyntheticRecord
} from "./synthetic-producer";

/**
 * A synthetic engineering source: versioned machine and PCB designs as a
 * future CAD/PCB application would publish them. Every fact the knowledge
 * side may rely on is modelled here so the conformance suite has something
 * real to probe:
 *
 * - a design has an ordered list of revisions and each revision is an
 *   immutable value; releasing appends a revision, it never edits one;
 * - the projection is the latest APPROVED revision, so a draft never leaks
 *   into a reader's evidence, and `status` says which state that is;
 * - dimensions carry their unit in the field name (`massKg`,
 *   `boardThicknessMm`) plus a `units` field, so "12" is never ambiguous;
 * - attachments are document references with an immutable version id;
 * - `link` is the owning application's authorized deep link to that exact
 *   revision; it authorizes on open;
 * - the access boundary is the company: a second company's design is `403`.
 */
export const ENGINEERING_EXAMPLE_ORIGIN = "https://engineering.example";
export const ENGINEERING_EXAMPLE_AUDIENCE = "engineering-audience";
export const ENGINEERING_EXAMPLE_COMPANY = "company-a";
export const ENGINEERING_EXAMPLE_OTHER_COMPANY = "company-b";

export type DesignRevision = Readonly<{
  revision: string;
  status: "draft" | "approved" | "obsolete";
  approvedAt: string | null;
  approvedBy: string | null;
  massKg?: number;
  boardThicknessMm?: number;
  layerCount?: number;
  attachments: ReadonlyArray<{ id: string; title: string; versionId: string }>;
}>;
export type Design = Readonly<{
  id: string;
  companyId: string;
  type: "machine" | "pcb" | "assembly" | "part";
  title: string;
  description: string;
  revisions: readonly DesignRevision[];
}>;

const grinderFrame: Design = {
  id: "grinder-frame-mk2",
  companyId: ENGINEERING_EXAMPLE_COMPANY,
  type: "machine",
  title: "Surface grinder frame Mk2",
  description: "Welded frame for the surface grinding cell",
  revisions: [
    {
      revision: "A",
      status: "obsolete",
      approvedAt: "2026-03-02T09:00:00Z",
      approvedBy: "engineer-1",
      massKg: 412.5,
      attachments: [
        {
          id: "grinder-frame-mk2-A-drawing",
          title: "Frame drawing rev A",
          versionId: "doc-frame-a"
        }
      ]
    },
    {
      revision: "B",
      status: "approved",
      approvedAt: "2026-07-14T15:30:00Z",
      approvedBy: "engineer-2",
      massKg: 418,
      attachments: [
        {
          id: "grinder-frame-mk2-B-drawing",
          title: "Frame drawing rev B",
          versionId: "doc-frame-b"
        },
        {
          id: "grinder-frame-mk2-B-fea",
          title: "FEA report rev B",
          versionId: "doc-frame-b-fea"
        }
      ]
    },
    {
      revision: "C",
      status: "draft",
      approvedAt: null,
      approvedBy: null,
      massKg: 402,
      attachments: []
    }
  ]
};
const motorController: Design = {
  id: "motor-controller-pcb",
  companyId: ENGINEERING_EXAMPLE_COMPANY,
  type: "pcb",
  title: "Motor controller PCB",
  description: "Four-layer servo drive board",
  revisions: [
    {
      revision: "A",
      status: "approved",
      approvedAt: "2026-05-20T10:00:00Z",
      approvedBy: "engineer-3",
      boardThicknessMm: 1.6,
      layerCount: 4,
      attachments: [
        {
          id: "motor-controller-pcb-A-gerbers",
          title: "Gerber set rev A",
          versionId: "doc-mc-a-gerbers"
        }
      ]
    }
  ]
};
const spindleAssembly: Design = {
  id: "spindle-assembly",
  companyId: ENGINEERING_EXAMPLE_COMPANY,
  type: "assembly",
  title: "Spindle assembly",
  description: "Grinding spindle with bearings and housing",
  revisions: [
    {
      revision: "A",
      status: "draft",
      approvedAt: null,
      approvedBy: null,
      massKg: 14.25,
      attachments: []
    }
  ]
};
const otherCompanyBoard: Design = {
  id: "tenant-b-sensor-board",
  companyId: ENGINEERING_EXAMPLE_OTHER_COMPANY,
  type: "pcb",
  title: "Sensor board",
  description: "Belongs to a different company",
  revisions: [
    {
      revision: "A",
      status: "approved",
      approvedAt: "2026-06-01T08:00:00Z",
      approvedBy: "engineer-9",
      boardThicknessMm: 1.0,
      layerCount: 2,
      attachments: []
    }
  ]
};

export const ENGINEERING_EXAMPLE_DESIGNS: readonly Design[] = [
  grinderFrame,
  motorController,
  spindleAssembly,
  otherCompanyBoard
];

/** The revision a reader may rely on: the latest approved one, else the latest. */
export function currentRevision(design: Design): DesignRevision {
  const approved = [...design.revisions]
    .reverse()
    .find((revision) => revision.status === "approved");
  const latest = design.revisions.at(-1);
  if (!latest) throw Error("A design needs at least one revision");
  return approved ?? latest;
}

export function designDeepLink(design: Design, revision: DesignRevision) {
  return `${ENGINEERING_EXAMPLE_ORIGIN}/designs/${encodeURIComponent(design.id)}/revisions/${encodeURIComponent(revision.revision)}`;
}

export function projectDesign(design: Design): SyntheticRecord {
  const revision = currentRevision(design);
  const entity: SourceEntity = {
    id: design.id,
    type: design.type,
    title: design.title,
    description: design.description,
    revision: `${design.id}@${revision.revision}`,
    fields: {
      status: revision.status,
      approvedAt: revision.approvedAt,
      approvedBy: revision.approvedBy,
      units: "SI",
      massKg: revision.massKg ?? null,
      boardThicknessMm: revision.boardThicknessMm ?? null,
      layerCount: revision.layerCount ?? null,
      link: designDeepLink(design, revision)
    }
  };
  return {
    companyId: design.companyId,
    readers: [],
    entity,
    facts: {
      status: [
        { label: "status", value: revision.status },
        { label: "approvedAt", value: revision.approvedAt ?? "" },
        { label: "approvedBy", value: revision.approvedBy ?? "" }
      ],
      revision: [{ label: "revision", value: revision.revision }],
      availability: [
        {
          label: "availability",
          value:
            revision.status === "approved"
              ? "released for production"
              : "not released"
        }
      ]
    },
    attachments: revision.attachments.map((attachment) => ({
      id: attachment.id,
      entityId: design.id,
      documentVersionId: attachment.versionId,
      title: attachment.title,
      relation: "specification-for" as const,
      sourceRevision: `${design.id}@${revision.revision}`
    })),
    searchTerms: [
      design.id,
      design.type,
      "design",
      design.title,
      design.description
    ]
  };
}

export function createEngineeringExampleProducer(options?: {
  clock?: () => string;
  rateLimitAfter?: number;
  designs?: readonly Design[];
}) {
  const designs = options?.designs ?? ENGINEERING_EXAMPLE_DESIGNS;
  const clock = options?.clock ?? (() => now("UTC").toAbsoluteString());
  const producer = createSyntheticProducer({
    descriptor: genericSourceDescriptor("engineering"),
    origin: ENGINEERING_EXAMPLE_ORIGIN,
    audience: ENGINEERING_EXAMPLE_AUDIENCE,
    records: designs.map(projectDesign),
    clock,
    rateLimitAfter: options?.rateLimitAfter
  });
  return {
    ...producer,
    /**
     * Approve a draft: a NEW revision value is appended and becomes the
     * projection. The design's earlier revision objects are untouched, so a
     * reader holding `grinder-frame-mk2@B` still names exactly what it saw.
     */
    release(designId: string, revision: string, approvedBy: string) {
      const design = designs.find((entry) => entry.id === designId);
      const draft = design?.revisions.find(
        (entry) => entry.revision === revision && entry.status === "draft"
      );
      if (!design || !draft) throw Error("No such draft revision");
      const released: Design = {
        ...design,
        revisions: design.revisions.map((entry) =>
          entry === draft
            ? { ...entry, status: "approved", approvedAt: clock(), approvedBy }
            : entry
        )
      };
      producer.publish(projectDesign(released));
    },
    probes: {
      searchQuery: "design",
      knownEntityId: grinderFrame.id,
      forbiddenEntityId: otherCompanyBoard.id,
      deletableEntityId: spindleAssembly.id,
      companyId: ENGINEERING_EXAMPLE_COMPANY,
      outsiderCompanyId: ENGINEERING_EXAMPLE_OTHER_COMPANY,
      subject: "engineer-1",
      outsiderSubject: "engineer-9"
    }
  };
}
