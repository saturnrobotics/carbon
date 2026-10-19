import type { ReactNode } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Radix dialogs render nothing on the server; plain elements stand in, and the
// real PermissionMatrix renders its checkboxes as buttons.
vi.mock("@carbon/react", () => {
  const element =
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children);
  return {
    Alert: element("section"),
    AlertDescription: element("div"),
    AlertTitle: element("h3"),
    Button: element("button"),
    Checkbox: ({ isChecked }: { isChecked?: boolean }) =>
      createElement("button", {
        role: "checkbox",
        "aria-checked": Boolean(isChecked)
      }),
    LabelWithHelp: element("span"),
    Modal: element("div"),
    ModalBody: element("div"),
    ModalContent: element("div"),
    ModalFooter: element("footer"),
    ModalHeader: element("header"),
    ModalTitle: element("h2"),
    Table: element("table"),
    Tbody: element("tbody"),
    Td: element("td"),
    Th: element("th"),
    Thead: element("thead"),
    Tr: element("tr"),
    VStack: element("div")
  };
});
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((out, part, i) => out + part + (values[i] ?? ""), "")
  })
}));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));

import AuthzManagedPermissions from "./AuthzManagedPermissions";

const ACCESS = "https://hq.example.com/admin/access";
const permission = (view: boolean) => ({
  view,
  create: false,
  update: false,
  delete: false
});

describe("AuthzManagedPermissions", () => {
  it("shows a person's permissions read-only and links to HQ", () => {
    const html = renderToStaticMarkup(
      createElement(AuthzManagedPermissions, {
        title: "Synthetic Person",
        accessUrl: ACCESS,
        companyPermissions: {
          sales: permission(true),
          parts: permission(false)
        }
      })
    );
    expect(html).toContain("Synthetic Person");
    expect(html).toContain("Managed in HQ");
    expect(html).toContain(`href="${ACCESS}"`);
    // Every checkbox sits inside a disabled fieldset, and nothing submits.
    expect(html).toMatch(
      /<fieldset disabled="" class="w-full">.*role="checkbox"/
    );
    expect(html.split("<fieldset")[0]).not.toContain('role="checkbox"');
    expect(html).not.toContain("<form");
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("Sales");
  });

  it("shows an employee type's permissions the same way", () => {
    const html = renderToStaticMarkup(
      createElement(AuthzManagedPermissions, {
        title: "Operators",
        accessUrl: ACCESS,
        employeeTypePermissions: {
          Sales: { name: "sales", permission: permission(true) }
        }
      })
    );
    expect(html).toMatch(/<fieldset disabled="".*aria-checked="true"/);
  });

  it("names the screen when there is nothing to show", () => {
    const html = renderToStaticMarkup(
      createElement(AuthzManagedPermissions, { accessUrl: ACCESS })
    );
    expect(html).toContain("<h2>Permissions</h2>");
    expect(html).not.toContain("<fieldset");
  });
});
