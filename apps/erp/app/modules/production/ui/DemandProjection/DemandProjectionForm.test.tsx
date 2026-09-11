import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { createServer, transformWithOxc } from "vite";
import { expect, it } from "vitest";

// Keep React's state/effect/deferred-render lifecycle real. Only replace service
// boundaries and chart layout, so this can inspect the actual chart data without
// a database, a router loader, or SVG measurements.
const boundarySource = `
import React from "react";
const Box = ({ children }) => <div>{children}</div>;
export const ValidatedForm = Box;
export const CardDescription = Box, CardTitle = Box, Drawer = Box,
  DrawerBody = Box, DrawerContent = Box, DrawerFooter = Box, DrawerHeader = Box,
  HStack = Box, Tabs = Box, TabsContent = Box, TabsList = Box, TabsTrigger = Box,
  VStack = Box, ChartContainer = Box;
export const Hidden = () => null, Item = () => null, Location = () => null,
  Submit = () => null, ChartTooltip = () => null, Bar = () => null,
  CartesianGrid = () => null, Line = () => null, XAxis = () => null, YAxis = () => null;
const NumberField = ({ name, onChange }) =>
  <input aria-label={name} onChange={event => onChange(parseFloat(event.target.value))} />;
export { NumberField as Number };
export const ComposedChart = ({ data }) => <output data-testid="chart">{JSON.stringify(data)}</output>;
const formatter = new Intl.NumberFormat("en-US");
export const useNumberFormatter = () => formatter;
const t = (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
export const useLingui = () => ({ t, i18n: { date: () => "week" } });
export const useFetcher = () => ({ state: "idle" });
export const useLoaderData = () => undefined;
export const usePermissions = () => ({ can: () => true });
export const path = { to: { demandProjection: () => "/projection", newDemandProjection: "/projection/new" } };
export const demandProjectionValidator = {};
`;

it("preserves chart edits on same-projection rerenders and reseeds for another item or location", async () => {
  if (!existsSync(chromium.executablePath())) {
    throw new Error(
      "Demand projection rendering requires pinned Playwright Chromium"
    );
  }
  const formPath = path.join(__dirname, "DemandProjectionForm.tsx");
  const boundaries = new Set([
    "@carbon/form",
    "@carbon/react",
    "@carbon/react/Chart",
    "@lingui/react/macro",
    "@react-aria/i18n",
    "react-router",
    "recharts",
    "~/components/Form",
    "~/hooks",
    "~/utils/path",
    "../../production.models"
  ]);
  const server = await createServer({
    configFile: false,
    root: __dirname,
    resolve: { dedupe: ["react", "react-dom"] },
    esbuild: { jsx: "automatic" },
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
      fs: { allow: [path.resolve(__dirname, "../../../../../../../..")] }
    },
    plugins: [
      {
        enforce: "pre",
        name: "demand-projection-rendering-fixture",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<div id="root"></div><script type="module" src="/projection-fixture.tsx"></script>'
            );
          });
        },
        resolveId(id, importer) {
          if (id === "/projection-fixture.tsx")
            return "\0projection-fixture.tsx";
          if (importer && boundaries.has(id))
            return "\0projection-boundaries.tsx";
        },
        transform(code, id) {
          if (id.startsWith("\0projection-"))
            return transformWithOxc(code, id, {
              lang: "tsx",
              jsx: { runtime: "automatic" }
            });
        },
        load(id) {
          if (id === "\0projection-boundaries.tsx") return boundarySource;
          if (id === "\0projection-fixture.tsx")
            return `
          import React, { StrictMode, useState } from "react";
          import { createRoot } from "react-dom/client";
          import Form from ${JSON.stringify(formPath)};
          function Harness() {
            const [initial, setInitial] = useState({ itemId: "item-a", locationId: "location-a", week0: 3 });
            return <>
              <button onClick={() => setInitial({ ...initial, week0: 99 })}>Same projection</button>
              <button onClick={() => setInitial({ itemId: "item-b", locationId: "location-a", week0: 8 })}>Another item</button>
              <button onClick={() => setInitial({ itemId: "item-b", locationId: "location-b", week0: 12 })}>Another location</button>
              <Form initialValues={initial} onClose={() => {}} />
            </>;
          }
          createRoot(document.getElementById("root")).render(<StrictMode><Harness /></StrictMode>);
        `;
        }
      }
    ]
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const address = server.httpServer?.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture port");
    await page.goto(`http://127.0.0.1:${address.port}`);
    const chart = async () => {
      expect(errors).toEqual([]);
      const data = JSON.parse(
        await page.getByTestId("chart").innerText()
      ) as Array<{
        week: number;
        demand: number;
        cumulative: number;
      }>;
      expect(data).toHaveLength(52);
      return [data[0]?.demand, data[51]?.cumulative];
    };
    await expect.poll(chart).toEqual([3, 3]);
    await page.getByRole("textbox", { name: "week0", exact: true }).fill("37");
    await expect.poll(chart).toEqual([37, 37]);
    await page.getByRole("button", { name: "Same projection" }).click();
    // Let the passive effect and deferred chart commit finish before asserting
    // an unchanged value; an immediate poll could accept the pre-effect chart.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        })
    );
    await expect.poll(chart).toEqual([37, 37]);
    await page.getByRole("button", { name: "Another item" }).click();
    await expect.poll(chart).toEqual([8, 8]);
    await page.getByRole("textbox", { name: "week0", exact: true }).fill("42");
    await expect.poll(chart).toEqual([42, 42]);
    await page.getByRole("button", { name: "Another location" }).click();
    await expect.poll(chart).toEqual([12, 12]);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    await server.close();
  }
}, 30_000);
