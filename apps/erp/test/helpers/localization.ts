import ts from "typescript";

function parse(source: string) {
  return ts.createSourceFile(
    "screen.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

function location(tree: ts.SourceFile, node: ts.Node, description: string) {
  return `line ${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}: ${description}`;
}

// msg only constructs a descriptor. useLingui from either React entry point
// reads the active provider; the unactivated core singleton is the unsafe path.
export function findUnsafeTranslations(source: string): string[] {
  const tree = parse(source);
  const issues: string[] = [];
  const coreNamespaces = new Set<string>();
  const macroNamespaces = new Set<string>();
  for (const node of tree.statements) {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      node.importClause?.isTypeOnly
    )
      continue;
    const module = node.moduleSpecifier.text;
    const bindings = node.importClause?.namedBindings;
    if (module === "@lingui/core/macro") {
      if (bindings && ts.isNamespaceImport(bindings))
        macroNamespaces.add(bindings.name.text);
      else if (
        !bindings ||
        bindings.elements.some(
          (binding) =>
            !binding.isTypeOnly &&
            (binding.propertyName ?? binding.name).text !== "msg"
        )
      ) {
        issues.push(
          location(
            tree,
            node,
            "core translation macros use the unactivated global runtime; use the React macro hook"
          )
        );
      }
    }
    if (module === "@lingui/core" && bindings) {
      if (ts.isNamespaceImport(bindings))
        coreNamespaces.add(bindings.name.text);
      else if (
        bindings.elements.some(
          (binding) =>
            !binding.isTypeOnly &&
            (binding.propertyName ?? binding.name).text === "i18n"
        )
      ) {
        issues.push(
          location(
            tree,
            node,
            "global i18n singleton; obtain the runtime from useLingui"
          )
        );
      }
    }
  }
  function unsafeMember(namespace: string, member: string) {
    return (
      (coreNamespaces.has(namespace) && member === "i18n") ||
      (macroNamespaces.has(namespace) && member !== "msg")
    );
  }
  function visit(node: ts.Node) {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      unsafeMember(node.expression.text, node.name.text)
    ) {
      issues.push(
        location(
          tree,
          node,
          "global translation runtime; obtain translations from useLingui"
        )
      );
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      ts.isObjectBindingPattern(node.name)
    ) {
      const namespace = node.initializer.text;
      if (
        node.name.elements.some((binding) =>
          unsafeMember(
            namespace,
            (binding.propertyName ?? binding.name).getText(tree)
          )
        )
      ) {
        issues.push(
          location(
            tree,
            node,
            "global translation runtime; obtain translations from useLingui"
          )
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return issues;
}

const actionLabels = new Set([
  "Edit",
  "Delete",
  "Delete Customer",
  "Delete RFQ",
  "Delete Quote",
  "Delete Sales Order",
  "Delete Purchase Invoice",
  "Share",
  "Preview",
  "Finalize",
  "Won",
  "Lost",
  "Cancel",
  "Reopen",
  "Ready for Quote",
  "Quote",
  "No Quote",
  "Post",
  "Payment",
  "Purchase Order",
  "Purchase Orders",
  "Receipt",
  "Receipts",
  "Confirm",
  "New Shipment",
  "New Invoice",
  "Shipments",
  "Ship",
  "Invoices",
  "Invoice",
  "Create Jobs",
  "Edit Shipping",
  "Add Shipping"
]);
const labelElements = new Set(["CardAttributeLabel", "Status"]);
const labelAttributes = new Set(["title", "label", "aria-label", "text"]);

function literalTexts(node: ts.Node): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return [node.text];
  if (ts.isTemplateExpression(node)) return [node.getText()];
  if (ts.isConditionalExpression(node))
    return [...literalTexts(node.whenTrue), ...literalTexts(node.whenFalse)];
  if (ts.isParenthesizedExpression(node)) return literalTexts(node.expression);
  return [];
}

export function findUntranslatedUi(source: string): string[] {
  const tree = parse(source);
  const transNames = new Set<string>();
  for (const node of tree.statements) {
    if (
      !ts.isImportDeclaration(node) ||
      node.importClause?.isTypeOnly ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      !["@lingui/react", "@lingui/react/macro"].includes(
        node.moduleSpecifier.text
      )
    )
      continue;
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (
          !binding.isTypeOnly &&
          (binding.propertyName ?? binding.name).text === "Trans"
        )
          transNames.add(binding.name.text);
      }
    } else if (bindings && ts.isNamespaceImport(bindings))
      transNames.add(`${bindings.name.text}.Trans`);
  }
  const issues: string[] = [];
  function visit(node: ts.Node, translated = false) {
    const insideTrans =
      translated ||
      (ts.isJsxElement(node) &&
        transNames.has(node.openingElement.tagName.getText(tree)));
    if (!insideTrans) {
      const texts = ts.isJsxText(node)
        ? [node.text]
        : ts.isJsxExpression(node) && node.expression
          ? literalTexts(node.expression)
          : [];
      const parentTag =
        node.parent && ts.isJsxElement(node.parent)
          ? node.parent.openingElement.tagName.getText(tree)
          : "";
      for (const text of texts) {
        if (
          /\p{L}/u.test(text) &&
          (actionLabels.has(text.trim()) || labelElements.has(parentTag))
        ) {
          issues.push(
            location(tree, node, `untranslated label: ${text.trim()}`)
          );
        }
      }
    }
    // Trans translates its message children, not arbitrary child attributes.
    if (
      ts.isJsxAttribute(node) &&
      labelAttributes.has(node.name.getText(tree)) &&
      node.initializer
    ) {
      const value = ts.isJsxExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      if (value && literalTexts(value).some((text) => text.trim()))
        issues.push(
          location(
            tree,
            node,
            `untranslated ${node.name.getText(tree)} attribute`
          )
        );
    }
    if (
      ts.isPropertyAssignment(node) &&
      ["header", "pluralHeader"].includes(
        node.name.getText(tree).replaceAll('"', "").replaceAll("'", "")
      ) &&
      literalTexts(node.initializer).some((text) => text.trim())
    ) {
      issues.push(location(tree, node, "untranslated table header"));
    }
    ts.forEachChild(node, (child) => visit(child, insideTrans));
  }
  visit(tree);
  return issues;
}
