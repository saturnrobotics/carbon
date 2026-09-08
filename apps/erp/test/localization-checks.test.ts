import { describe, expect, it } from "vitest";
import {
  findUnsafeTranslations,
  findUntranslatedUi
} from "./helpers/localization";

describe("translation runtime checks", () => {
  it.each([
    'import { msg } from "@lingui/core/macro"; export const handle = { breadcrumb: msg`Account` };',
    'import { msg as descriptor } from "@lingui/core/macro"; const labels = { part: descriptor`Part` };',
    'import * as descriptors from "@lingui/core/macro"; export const handle = { breadcrumb: descriptors.msg`Account` };',
    'import { useLingui } from "@lingui/react"; function Label() { const { i18n } = useLingui(); return i18n._(descriptor); }',
    'import { useLingui } from "@lingui/react/macro"; function Label() { const { t } = useLingui(); return t`Tax Status`; }',
    '// import { t } from "@lingui/core/macro";\nconst example = "@lingui/core/macro";'
  ])("accepts descriptors and context-bound translation: %s", (source) => {
    expect(findUnsafeTranslations(source)).toEqual([]);
  });

  it.each([
    'import { t } from "@lingui/core/macro"; const label = t`Tax Status`;',
    'import { t as translate } from "@lingui/core/macro"; const label = translate`Tax Status`;',
    'import * as macros from "@lingui/core/macro"; const label = macros.t`Tax Status`;',
    'import { i18n as globalRuntime } from "@lingui/core"; const label = globalRuntime._(descriptor);',
    'import * as core from "@lingui/core"; const label = core.i18n._(descriptor);',
    'import * as core from "@lingui/core"; const { i18n: globalRuntime } = core;'
  ])("rejects the unactivated global runtime: %s", (source) => {
    expect(findUnsafeTranslations(source).length).toBeGreaterThan(0);
  });
});

describe("localized JSX checks", () => {
  it.each([
    'import { Trans } from "@lingui/react/macro"; const view = <MenuItem><Trans>Edit</Trans></MenuItem>;',
    'import { Trans as Translate } from "@lingui/react/macro"; const view = <Status><Translate>Exempt</Translate></Status>;',
    'import * as Lingui from "@lingui/react/macro"; const view = <MenuItem><Lingui.Trans>Delete</Lingui.Trans></MenuItem>;',
    "const view = <CardAttributeLabel>{t`Tax Status`}</CardAttributeLabel>;",
    "const column = { header: t`Tax Status`, pluralHeader: t`Customers` };",
    "const view = <New label={t`Customer`} title={t`New Customer`} aria-label={t`More options`} />;",
    "const view = <div>{/* <MenuItem>Edit</MenuItem> */}</div>;"
  ])("accepts marked messages and ignores comments: %s", (source) => {
    expect(findUntranslatedUi(source)).toEqual([]);
  });

  it.each([
    "const view = <MenuItem>Edit</MenuItem>;",
    "const view = <Trans>Delete</Trans>;",
    "const view = <CardAttributeLabel>Tax Status</CardAttributeLabel>;",
    "const view = <Status>Exempt</Status>;",
    'const view = <Status>{"Taxable"}</Status>;',
    'const view = <Status>{taxExempt ? "Exempt" : "Taxable"}</Status>;',
    'import { Trans } from "@lingui/react/macro"; const view = <Trans><button title="More options">Edit</button></Trans>;',
    'import type { Trans } from "@lingui/react/macro"; const view = <Trans>Delete</Trans>;',
    'const view = <New label="Customer" />;',
    'const view = <IconButton aria-label="More options" />;',
    'const column = { header: "Tax Status" };',
    `const view = <Confirm text={\`Are you sure you want to delete \${name}? This cannot be undone.\`} />;`
  ])("rejects unmarked labels: %s", (source) => {
    expect(findUntranslatedUi(source).length).toBeGreaterThan(0);
  });

  it("reports the same violation in consecutive files", () => {
    const source = "const view = <MenuItem>Edit</MenuItem>;";
    expect(findUntranslatedUi(source)).toEqual(findUntranslatedUi(source));
    expect(findUntranslatedUi(source).length).toBeGreaterThan(0);
  });
});
