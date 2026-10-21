// Invite acceptance while HQ manages Carbon's permissions (HQ plan 0006B). The
// real acceptInvite runs against a recording Supabase client. While the
// projection is off it sends upstream's requests: the invite's permissions are
// merged into userPermission, and any failed write rolls the invite back. While
// it is on it writes membership only, so a userPermission row the projection
// has not synced yet (which the lock refuses with 42501) cannot fail it. The
// real invite route tells the invitee that access arrives from HQ.
import type { ReactNode } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  status: { enabled: false, access_url: null } as
    | { enabled: boolean; access_url: string | null }
    | Error,
  statusQueries: [] as string[],
  client: null as unknown,
  loaderData: {} as Record<string, unknown>,
  logged: [] as unknown[],
  cacheDeletes: [] as string[]
}));

vi.mock("@carbon/database/client", () => ({
  getPostgresConnectionPool: () => ({
    query: async (text: string) => {
      h.statusQueries.push(text);
      if (h.status instanceof Error) throw h.status;
      return { rows: [h.status] };
    }
  })
}));
vi.mock("@carbon/auth/client.server", () => ({
  getCarbonServiceRole: () => h.client
}));
vi.mock("@carbon/auth/auth.server", () => ({}));
vi.mock("@carbon/auth/auth-events.server", () => ({}));
vi.mock("@carbon/auth/company.server", () => ({}));
vi.mock("@carbon/auth/session.server", () => ({}));
vi.mock("@carbon/auth/users.server", () => ({}));
vi.mock("@carbon/database/audit", () => ({}));
vi.mock("@carbon/documents/email", () => ({}));
vi.mock("@carbon/ee/sso.server", () => ({}));
vi.mock("@carbon/kv", () => ({
  redis: { del: async (key: string) => h.cacheDeletes.push(key) }
}));
vi.mock("@carbon/lib/resend.server", () => ({}));
vi.mock("@carbon/logger", () => ({
  getLogger: () => ({
    error: (...args: unknown[]) => h.logged.push(args),
    info: vi.fn(),
    warn: vi.fn()
  })
}));
vi.mock("@carbon/stripe/stripe.server", () => ({}));
vi.mock("@react-email/components", () => ({}));
vi.mock("~/modules/people/people.service", () => ({}));
vi.mock("~/modules/purchasing", () => ({}));
vi.mock("~/modules/sales", () => ({}));
vi.mock("~/modules/users", () => ({}));
vi.mock("~/services/database.server", () => ({}));
// The page renders with plain elements; Lingui's macros are not compiled here.
vi.mock("@carbon/react", () => {
  const element =
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children);
  return {
    Button: element("button"),
    Heading: element("h1"),
    VStack: element("div")
  };
});
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray) => parts.join("")
  })
}));
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  Form: ({ children }: { children?: ReactNode }) =>
    createElement("form", null, children),
  Link: ({ children }: { children?: ReactNode }) =>
    createElement("a", null, children),
  useLoaderData: () => h.loaderData
}));

import { acceptInvite } from "~/modules/users/users.server";
import Invite, { loader } from "~/routes/_public+/invite.$code";

const CODE = "code_1";
const COMPANY = "cmp_1";
const OTHER = "cmp_2";
const USER = "usr_1";
const EMAIL = "person@example.com";
const MANAGED = {
  enabled: true,
  access_url: "https://hq.example.com/admin/access"
};
const INVITE = {
  id: "inv_1",
  code: CODE,
  email: EMAIL,
  companyId: COMPANY,
  role: "employee" as "employee" | "customer" | "supplier",
  permissions: { sales_view: [COMPANY], parts_view: [COMPANY] },
  createdAt: "2026-10-20T00:00:00.000Z",
  acceptedAt: null as string | null,
  revokedAt: null
};
const STORED = { sales_view: [OTHER] };
const MERGED = { sales_view: [OTHER, COMPANY], parts_view: [COMPANY] };
/** The guard's answer to the merge's upsert when the stored row is not yet the
 *  projection: the INSERT becomes the projection, the ON CONFLICT UPDATE then
 *  changes the row, and the guard refuses that. */
const REFUSED = {
  code: "42501",
  message:
    "Carbon permissions are managed by HQ: userPermission cannot be changed in Carbon"
};
const NOTICE =
  "Your access in Carbon is managed in HQ. After you join, it may take a minute to appear.";

type Op = {
  table: string;
  action: "select" | "insert" | "update" | "delete" | "upsert";
  values?: unknown;
  calls: string[];
};

/** A Supabase client that records every request, and every call that shapes
 *  it, and answers it. */
function recordingClient({
  invite = INVITE,
  permissionUpsertError = null as typeof REFUSED | null
} = {}) {
  const ops: Op[] = [];
  const answer = (op: Op) => {
    switch (`${op.action} ${op.table}`) {
      case "select invite":
        return { data: invite, error: null };
      case "select user":
        return { data: { id: USER, email: EMAIL }, error: null };
      case "update employee":
      case "update customerAccount":
      case "update supplierAccount":
        return { data: [{ id: USER }], error: null };
      case "select userPermission":
        return { data: { permissions: STORED }, error: null };
      case "upsert userPermission":
        return { data: null, error: permissionUpsertError };
      case "update invite":
        return {
          data: { ...invite, acceptedAt: "2026-10-20T12:00:00.000Z" },
          error: null
        };
      default:
        return { data: null, error: null };
    }
  };
  const client = {
    from(table: string) {
      const builder = (action: Op["action"], values?: unknown) => {
        const op: Op = { table, action, values, calls: [] };
        ops.push(op);
        const record =
          (name: string) =>
          (...args: unknown[]) => {
            op.calls.push(`${name}(${args.map(String).join(",")})`);
            return chain;
          };
        const chain = {
          eq: record("eq"),
          is: record("is"),
          select: record("select"),
          single: record("single"),
          maybeSingle: record("maybeSingle"),
          then: (
            resolve: (value: unknown) => unknown,
            reject?: (reason: unknown) => unknown
          ) => Promise.resolve(answer(op)).then(resolve, reject)
        };
        return chain;
      };
      return {
        select: (columns: string) => builder("select", columns),
        insert: (values: unknown) => builder("insert", values),
        update: (values: unknown) => builder("update", values),
        delete: () => builder("delete"),
        upsert: (values: unknown) => builder("upsert", values)
      };
    }
  };
  h.client = client;
  return { client: client as never, ops };
}

const ACCOUNT_TABLE = {
  employee: "employee",
  customer: "customerAccount",
  supplier: "supplierAccount"
} as const;

const membershipFor = (role: keyof typeof ACCOUNT_TABLE): Op[] => [
  {
    table: "invite",
    action: "select",
    values: "*",
    calls: [
      `eq(code,${CODE})`,
      "is(acceptedAt,null)",
      "is(revokedAt,null)",
      "single()"
    ]
  },
  {
    table: "user",
    action: "select",
    values: "*",
    calls: [`eq(email,${EMAIL})`, "single()"]
  },
  {
    table: ACCOUNT_TABLE[role],
    action: "update",
    values: { active: true },
    calls: [`eq(id,${USER})`, `eq(companyId,${COMPANY})`, "select(id)"]
  },
  {
    table: "userToCompany",
    action: "insert",
    values: { userId: USER, companyId: COMPANY, role },
    calls: []
  }
];

const PERMISSION_MERGE: Op[] = [
  {
    table: "userPermission",
    action: "select",
    values: "permissions",
    calls: [`eq(id,${USER})`, "maybeSingle()"]
  },
  {
    table: "userPermission",
    action: "upsert",
    values: { id: USER, permissions: MERGED },
    calls: []
  }
];

const ACCEPTED: Op = {
  table: "invite",
  action: "update",
  values: { acceptedAt: expect.any(String) },
  calls: [`eq(code,${CODE})`, "select(*)", "single()"]
};

const ROLLBACK: Op[] = [
  {
    table: "employee",
    action: "update",
    values: { active: false },
    calls: [`eq(id,${USER})`, `eq(companyId,${COMPANY})`]
  },
  ...["userToCompany", "customerAccount", "supplierAccount"].map(
    (table): Op => ({
      table,
      action: "delete",
      values: undefined,
      calls: [`eq(userId,${USER})`, `eq(companyId,${COMPANY})`]
    })
  )
];

/** Upstream's requests, in order, for an employee invite. */
const UPSTREAM: Op[] = [
  ...membershipFor("employee"),
  ...PERMISSION_MERGE,
  ACCEPTED
];

const userPermissionRequests = (ops: Op[]) =>
  ops.filter((op) => op.table === "userPermission");

beforeEach(() => {
  h.status = { enabled: false, access_url: null };
  h.statusQueries = [];
  h.loaderData = {};
  h.logged = [];
  h.cacheDeletes = [];
});

describe("acceptInvite while Carbon manages permissions", () => {
  it("sends upstream's requests and merges the invite's permissions", async () => {
    const { client, ops } = recordingClient();
    const accepted = await acceptInvite(client, CODE, EMAIL);

    expect(accepted.error).toBeNull();
    expect(accepted.data).toMatchObject({ id: "inv_1", companyId: COMPANY });
    expect(ops).toEqual(UPSTREAM);
    expect(h.cacheDeletes).toEqual([`permissions:${USER}`]);
  });

  it("reads the lock once per acceptance", async () => {
    const { client } = recordingClient();
    await acceptInvite(client, CODE, EMAIL);
    expect(h.statusQueries).toEqual([
      "SELECT enabled, access_url FROM carbon_private.authz_projection_status()"
    ]);
  });

  it("rolls the invite back when the permission write fails, as upstream does", async () => {
    const { client, ops } = recordingClient({
      permissionUpsertError: REFUSED
    });
    const accepted = await acceptInvite(client, CODE, EMAIL);

    expect(accepted).toEqual({ data: null, error: REFUSED });
    expect(ops).toEqual([
      ...membershipFor("employee"),
      ...PERMISSION_MERGE,
      ...ROLLBACK
    ]);
  });
});

describe("acceptInvite while HQ manages permissions", () => {
  it.each([
    "employee",
    "customer",
    "supplier"
  ] as const)("writes %s membership only and accepts the invite", async (role) => {
    h.status = MANAGED;
    const { client, ops } = recordingClient({
      invite: { ...INVITE, role }
    });
    const accepted = await acceptInvite(client, CODE, EMAIL);

    expect(accepted.error).toBeNull();
    expect(accepted.data).toMatchObject({ id: "inv_1", companyId: COMPANY });
    expect(userPermissionRequests(ops)).toEqual([]);
    expect(ops).toEqual([...membershipFor(role), ACCEPTED]);
  });

  it("accepts while the user's row is not yet the projection", async () => {
    h.status = MANAGED;
    // The lock would refuse the invite's merge into an unsynced row.
    const { client, ops } = recordingClient({
      permissionUpsertError: REFUSED
    });
    const accepted = await acceptInvite(client, CODE, EMAIL);

    expect(accepted.error).toBeNull();
    expect(accepted.data).toMatchObject({
      acceptedAt: "2026-10-20T12:00:00.000Z"
    });
    expect(userPermissionRequests(ops)).toEqual([]);
    expect(ops).toEqual([...membershipFor("employee"), ACCEPTED]);
    expect(h.logged).toEqual([]);
  });

  it("writes membership only before HQ's access page is configured", async () => {
    h.status = { enabled: true, access_url: null };
    const { client, ops } = recordingClient({
      permissionUpsertError: REFUSED
    });
    await expect(acceptInvite(client, CODE, EMAIL)).resolves.toMatchObject({
      error: null
    });
    expect(userPermissionRequests(ops)).toEqual([]);
  });
});

describe("acceptInvite when the lock cannot be read", () => {
  it("falls back to upstream's requests", async () => {
    h.status = new Error("connection refused");
    const { client, ops } = recordingClient();
    const accepted = await acceptInvite(client, CODE, EMAIL);

    expect(accepted.error).toBeNull();
    expect(ops).toEqual(UPSTREAM);
    expect(h.logged).toEqual([
      ["Failed to read whether HQ manages permissions", { error: h.status }]
    ]);
  });
});

type LoaderArgs = Parameters<typeof loader>[0];
const loadInvite = (invite: Partial<typeof INVITE> = {}) => {
  recordingClient({
    invite: { ...INVITE, ...invite, company: { name: "Synthetic Co" } } as never
  });
  return loader({
    request: new Request(`https://erp.example.com/invite/${CODE}`),
    params: { code: CODE },
    context: {}
  } as unknown as LoaderArgs);
};

const renderInvite = async () => {
  h.loaderData = await loadInvite();
  return renderToStaticMarkup(createElement(Invite));
};

describe("the invite page", () => {
  it("tells the invitee that access arrives from HQ while HQ manages it", async () => {
    h.status = MANAGED;
    await expect(loadInvite()).resolves.toMatchObject({
      success: true,
      authzManaged: true
    });
    const html = await renderInvite();
    expect(html).toContain(NOTICE);
    expect(html).toContain("Join Synthetic Co");
    // The page is public: it never says where HQ's access page is.
    expect(html).not.toContain("hq.example.com");
  });

  it("is upstream's page while Carbon manages permissions", async () => {
    await expect(loadInvite()).resolves.toMatchObject({
      success: true,
      authzManaged: false
    });
    const html = await renderInvite();
    expect(html).toContain("Join Synthetic Co");
    expect(html).not.toContain("managed in HQ");
  });

  it("is upstream's page when the lock cannot be read", async () => {
    h.status = new Error("connection refused");
    await expect(loadInvite()).resolves.toMatchObject({
      authzManaged: false
    });
  });

  it("reads nothing for an invite that cannot be accepted", async () => {
    h.status = MANAGED;
    await expect(
      loadInvite({ acceptedAt: "2026-10-19T00:00:00.000Z" })
    ).resolves.toEqual({ success: false, expired: false, company: null });
    expect(h.statusQueries).toEqual([]);
  });
});
