# Upload a Public 3D Model

This example demonstrates how to upload an RFQ with a 3D model through the Carbon API. Most files uploaded to Carbon aren't publicly accessible, but for 3D models, we provide a public endpoint for serving the file without standard authentication so that you can use them on your website.

### Getting Started

First run Carbon locally. In this example directory, copy `.env.example` to
`.env.local` and fill in your API key, public key, company ID, and local URLs.
Keep the populated file local; only the empty example belongs in Git.

```bash
cp .env.example .env.local
```

```bash
pnpm run dev
```

```bash
cd examples/upload-3d-model
pnpm run start
```

### Relevant Files

- `./components/ModelUpload.tsx`
- `./lib/carbon.server.ts`
- `./routes/_index.tsx`
