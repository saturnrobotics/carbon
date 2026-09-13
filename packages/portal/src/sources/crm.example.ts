import { genericSourceDescriptor } from "./generic.server";
import {
  createSyntheticProducer,
  type SourceEntity,
  type SyntheticRecord
} from "./synthetic-producer";

/**
 * A synthetic CRM source: customers and their contacts as a future CRM
 * application would publish them. What it models beyond the engineering
 * example is the access boundary INSIDE a company: a customer is readable
 * only by its account team, and a contact inherits its customer's boundary.
 * A reader off the team gets `403` for the record, never sees it in a
 * search, and cannot learn it exists through `access/check`. Erasing a
 * contact leaves a tombstone that carries the id and nothing else.
 */
export const CRM_EXAMPLE_ORIGIN = "https://crm.example";
export const CRM_EXAMPLE_AUDIENCE = "crm-audience";
export const CRM_EXAMPLE_COMPANY = "company-a";
export const CRM_EXAMPLE_OTHER_COMPANY = "company-b";

export type Contact = Readonly<{
  id: string;
  name: string;
  role: string;
  email: string;
  phone: string;
}>;
export type Customer = Readonly<{
  id: string;
  companyId: string;
  name: string;
  territory: string;
  accountOwner: string;
  status: "prospect" | "active" | "churned";
  /** Verified subjects on the account team; the customer's read boundary. */
  accountTeam: readonly string[];
  version: number;
  contacts: readonly Contact[];
  documents: ReadonlyArray<{ id: string; title: string; versionId: string }>;
}>;

const northernMachining: Customer = {
  id: "cust-northern-machining",
  companyId: CRM_EXAMPLE_COMPANY,
  name: "Northern Machining Ltd",
  territory: "north",
  accountOwner: "alice",
  status: "active",
  accountTeam: ["alice", "bob"],
  version: 4,
  contacts: [
    {
      id: "contact-northern-buyer",
      name: "Buyer One",
      role: "Purchasing",
      email: "buyer@northern.example",
      phone: "+1-555-0100"
    },
    {
      id: "contact-northern-engineer",
      name: "Engineer Two",
      role: "Engineering",
      email: "eng@northern.example",
      phone: "+1-555-0101"
    }
  ],
  documents: [
    {
      id: "cust-northern-machining-msa",
      title: "Master services agreement",
      versionId: "doc-northern-msa-2"
    }
  ]
};
const southernRobotics: Customer = {
  id: "cust-southern-robotics",
  companyId: CRM_EXAMPLE_COMPANY,
  name: "Southern Robotics Inc",
  territory: "south",
  accountOwner: "bob",
  status: "prospect",
  accountTeam: ["bob"],
  version: 1,
  contacts: [
    {
      id: "contact-southern-founder",
      name: "Founder Three",
      role: "Founder",
      email: "founder@southern.example",
      phone: "+1-555-0200"
    }
  ],
  documents: []
};
const otherCompanyCustomer: Customer = {
  id: "cust-tenant-b-account",
  companyId: CRM_EXAMPLE_OTHER_COMPANY,
  name: "Tenant B account",
  territory: "east",
  accountOwner: "carol",
  status: "active",
  accountTeam: [],
  version: 2,
  contacts: [],
  documents: []
};

export const CRM_EXAMPLE_CUSTOMERS: readonly Customer[] = [
  northernMachining,
  southernRobotics,
  otherCompanyCustomer
];

export function customerDeepLink(customer: Customer) {
  return `${CRM_EXAMPLE_ORIGIN}/customers/${encodeURIComponent(customer.id)}`;
}

export function projectCustomer(customer: Customer): SyntheticRecord {
  const revision = `${customer.id}@v${customer.version}`;
  const entity: SourceEntity = {
    id: customer.id,
    type: "customer",
    title: customer.name,
    revision,
    fields: {
      status: customer.status,
      territory: customer.territory,
      accountOwner: customer.accountOwner,
      link: customerDeepLink(customer)
    }
  };
  const primary = customer.contacts[0];
  return {
    companyId: customer.companyId,
    readers: customer.accountTeam,
    entity,
    facts: {
      status: [{ label: "status", value: customer.status }],
      "contact-summary": [
        { label: "contacts", value: `${customer.contacts.length}` },
        {
          label: "primaryContact",
          value: primary ? `${primary.name} (${primary.role})` : ""
        }
      ]
    },
    attachments: customer.documents.map((document) => ({
      id: document.id,
      entityId: customer.id,
      documentVersionId: document.versionId,
      title: document.title,
      relation: "related" as const,
      sourceRevision: revision
    })),
    searchTerms: [
      customer.id,
      "customer",
      customer.name,
      customer.territory,
      customer.accountOwner
    ]
  };
}

export function projectContact(
  customer: Customer,
  contact: Contact
): SyntheticRecord {
  const revision = `${contact.id}@${customer.id}@v${customer.version}`;
  const entity: SourceEntity = {
    id: contact.id,
    type: "contact",
    title: contact.name,
    revision,
    fields: {
      status: customer.status,
      territory: customer.territory,
      accountOwner: customer.accountOwner,
      email: contact.email,
      phone: contact.phone,
      link: `${customerDeepLink(customer)}/contacts/${encodeURIComponent(contact.id)}`
    }
  };
  return {
    companyId: customer.companyId,
    readers: customer.accountTeam,
    entity,
    facts: {
      status: [{ label: "status", value: customer.status }],
      "contact-summary": [
        { label: "role", value: contact.role },
        { label: "customer", value: customer.name }
      ]
    },
    attachments: [],
    searchTerms: [
      contact.id,
      "contact",
      contact.name,
      contact.role,
      customer.name
    ]
  };
}

export function createCrmExampleProducer(options?: {
  clock?: () => string;
  rateLimitAfter?: number;
  customers?: readonly Customer[];
}) {
  const customers = options?.customers ?? CRM_EXAMPLE_CUSTOMERS;
  const producer = createSyntheticProducer({
    descriptor: genericSourceDescriptor("crm"),
    origin: CRM_EXAMPLE_ORIGIN,
    audience: CRM_EXAMPLE_AUDIENCE,
    records: customers.flatMap((customer) => [
      projectCustomer(customer),
      ...customer.contacts.map((contact) => projectContact(customer, contact))
    ]),
    clock: options?.clock,
    rateLimitAfter: options?.rateLimitAfter
  });
  return {
    ...producer,
    probes: {
      searchQuery: "northern",
      knownEntityId: northernMachining.id,
      /** Alice is not on this account team; the boundary is inside her company. */
      forbiddenEntityId: southernRobotics.id,
      deletableEntityId: "contact-northern-engineer",
      companyId: CRM_EXAMPLE_COMPANY,
      outsiderCompanyId: CRM_EXAMPLE_OTHER_COMPANY,
      subject: "alice",
      outsiderSubject: "carol"
    }
  };
}
