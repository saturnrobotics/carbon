import { existsSync } from "node:fs";
import path from "node:path";
import { lingui } from "@lingui/vite-plugin";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import babelMacros from "vite-plugin-babel-macros";
import { expect, it } from "vitest";

it("updates descriptors, memoized labels and Trans without remounting when the locale changes", async () => {
  if (!existsSync(chromium.executablePath())) {
    throw new Error(
      "Localization rendering requires pinned Chromium. Run: corepack pnpm --dir apps/erp exec playwright-core install chromium"
    );
  }
  const server = await createServer({
    configFile: false,
    root: path.join(__dirname, "fixtures/localization-rendering"),
    plugins: [babelMacros(), lingui()],
    resolve: { dedupe: ["react", "react-dom"] },
    server: {
      host: "127.0.0.1",
      port: 0,
      fs: { allow: [path.resolve(__dirname, "../../..")] }
    },
    logLevel: "error"
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const address = server.httpServer?.address();
    if (!address || typeof address === "string")
      throw new Error("Localization fixture did not allocate a local port");
    await page.goto(`http://127.0.0.1:${address.port}`);
    const labels = async () => {
      expect(errors).toEqual([]);
      return page.locator("p[data-testid]").allTextContents();
    };
    await expect
      .poll(labels)
      .toEqual(["Part", "Tax Status", "Exempt", "Taxable"]);
    await page.getByTestId("state").click();
    await page.getByRole("button", { name: "es", exact: true }).click();
    await expect
      .poll(labels)
      .toEqual([
        "Pieza",
        "Estado fiscal",
        "Exento de impuestos",
        "Sujeto a impuestos"
      ]);
    expect(await page.getByTestId("state").textContent()).toBe("1");
    await page.getByRole("button", { name: "en", exact: true }).click();
    await expect
      .poll(labels)
      .toEqual(["Part", "Tax Status", "Exempt", "Taxable"]);
    expect(await page.getByTestId("state").textContent()).toBe("1");
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    await server.close();
  }
}, 30_000);
