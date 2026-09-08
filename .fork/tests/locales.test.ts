import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const checker = resolve(".fork/check-locales.ts");
const source = `import { Trans } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
export const heading = msg({ id: "fixture.heading", message: "Fixture heading" });
export const button = <Trans id="fixture.button">Fixture button</Trans>;
`;
const messages = `#. js-lingui-explicit-id
msgid "fixture.heading"
msgstr "Fixture heading"

#. js-lingui-explicit-id
msgid "fixture.button"
msgstr "Fixture button"
`;

function fixture(run: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "carbon-locales-"));
  try {
    writeFileSync(join(directory, "screen.tsx"), source);
    writeFileSync(
      join(directory, "lingui.config.cjs"),
      `module.exports = ${JSON.stringify({
        rootDir: directory,
        sourceLocale: "en",
        locales: ["en", "es"],
        format: "po",
        catalogs: [
          {
            path: join(directory, "{locale}"),
            include: [join(directory, "screen.tsx")]
          }
        ]
      })};`
    );
    for (const locale of ["en", "es"]) {
      writeFileSync(join(directory, `${locale}.po`), messages);
    }
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function check(directory: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", checker, join(directory, "lingui.config.cjs")],
    { encoding: "utf8", timeout: 30_000 }
  );
}

test("real Lingui extraction accepts covered Trans and msg descriptors without writes", () => {
  fixture((directory) => {
    const result = check(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 source messages/);
    for (const locale of ["en", "es"]) {
      assert.equal(
        readFileSync(join(directory, `${locale}.po`), "utf8"),
        messages
      );
    }
    assert.equal(readFileSync(join(directory, "screen.tsx"), "utf8"), source);
  });
});

for (const [kind, added] of [
  ["Trans", "export const added = <Trans>New fixture button</Trans>;"],
  ["msg", "export const added = msg`New fixture heading`;"]
]) {
  test(`fails when a new ${kind} source message is entirely absent from catalogs`, () => {
    fixture((directory) => {
      writeFileSync(join(directory, "screen.tsx"), source + added);
      const result = check(directory);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Missing source message/);
      assert.match(result.stderr, /en\.po/);
      assert.match(result.stderr, /es\.po/);
      assert.doesNotMatch(result.stderr, /New fixture/);
    });
  });
}

test("requires coverage in every configured locale", () => {
  fixture((directory) => {
    writeFileSync(join(directory, "es.po"), "");
    const result = check(directory);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Missing source message.*es\.po/);
    assert.doesNotMatch(result.stderr, /Missing source message.*en\.po/);
  });
});

test("preserves unrelated authored obsolete translations", () => {
  fixture((directory) => {
    const previous = `${messages}\n#~ msgid "Retired fixture"\n#~ msgstr "Saved translation"\n`;
    writeFileSync(join(directory, "es.po"), previous);
    const result = check(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(directory, "es.po"), "utf8"), previous);
  });
});

test("an obsolete catalog entry cannot cover an active source message", () => {
  fixture((directory) => {
    writeFileSync(
      join(directory, "es.po"),
      messages.replace(
        'msgid "fixture.button"\nmsgstr "Fixture button"',
        '#~ msgid "fixture.button"\n#~ msgstr "Fixture button"'
      )
    );
    const result = check(directory);
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /Obsolete source message.*es\.po.*fixture\.button/
    );
  });
});

test("a real source syntax error fails extraction instead of passing an empty catalog", () => {
  fixture((directory) => {
    writeFileSync(
      join(directory, "screen.tsx"),
      source + "export const broken = <Trans>;"
    );
    const result = check(directory);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Extraction failed/);
  });
});

test("matching source files without extracted messages cannot produce vacuous success", () => {
  fixture((directory) => {
    writeFileSync(join(directory, "screen.tsx"), "export const unrelated = 1;");
    const result = check(directory);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /No source messages extracted/);
  });
});

function assertLocaleInventory(configured: string[], runtimeSource: string) {
  const parsed = ts.createSourceFile(
    "config.ts",
    runtimeSource,
    ts.ScriptTarget.Latest,
    true
  );
  const declarations = parsed.statements
    .filter(ts.isVariableStatement)
    .filter((statement) =>
      statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
      )
    )
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter(
      (declaration) =>
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "supportedLanguages"
    );
  assert.equal(declarations.length, 1, "Expected exported supportedLanguages");
  let value = declarations[0]?.initializer;
  if (value && ts.isAsExpression(value)) value = value.expression;
  assert(
    value && ts.isArrayLiteralExpression(value),
    "supportedLanguages must remain a readable literal array"
  );
  const supported = value.elements.map((element) => {
    assert(ts.isStringLiteral(element), "Expected literal supported language");
    return element.text;
  });
  assert(supported.length, "Expected at least one supported language");
  assert.equal(new Set(supported).size, supported.length);
  assert.deepEqual(
    [...configured].sort(),
    supported.sort(),
    "Lingui locales must match runtime supportedLanguages"
  );
}

test("real Lingui configuration covers exactly the runtime selectable languages", () => {
  const requireCli = createRequire(
    createRequire(import.meta.url).resolve("@lingui/cli")
  );
  const { getConfig } = requireCli("@lingui/conf") as {
    getConfig: () => { locales: string[] };
  };
  assertLocaleInventory(
    getConfig().locales,
    readFileSync("packages/locale/src/config.ts", "utf8")
  );
});

test("locale inventory rejects omitted selectable languages and unreadable exports", () => {
  assert.throws(
    () =>
      assertLocaleInventory(
        ["en"],
        'export const supportedLanguages = ["en", "es"] as const;'
      ),
    /Lingui locales must match/
  );
  assert.throws(
    () =>
      assertLocaleInventory(
        ["en"],
        "export const supportedLanguages = loadLanguages();"
      ),
    /readable literal array/
  );
});
