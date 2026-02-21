# codex-ai-sdk-provider

`codex-ai-sdk-provider` is a TypeScript library scaffold for building a custom provider for **Vercel AI SDK v6** that targets the **Codex App Server Protocol**.

This repository currently focuses on production-ready package infrastructure (build, tests, linting, formatting, and strict typing). The provider implementation is intentionally minimal and will be expanded in future steps.

## Installation

```bash
npm install codex-ai-sdk-provider ai
```

## Basic Usage

```ts
import { createCodexProvider, createCodexStream } from 'codex-ai-sdk-provider';

const provider = createCodexProvider({
  baseUrl: 'https://your-codex-server.example.com',
  apiKey: process.env.CODEX_API_KEY,
});

for await (const chunk of createCodexStream()) {
  console.log(chunk);
}

console.log(provider.name);
```

## Development

### Prerequisites

- Node.js 18+
- npm 9+

### Setup

```bash
npm install
```

### Scripts

- `npm run build` - bundle to `dist/` using `tsup`
- `npm run dev` - watch mode build
- `npm run typecheck` - TypeScript checks with strict settings
- `npm run test` - run test suite with Vitest
- `npm run test:watch` - run tests in watch mode
- `npm run lint` - lint code with ESLint
- `npm run lint:fix` - auto-fix lint issues
- `npm run format` - check formatting with Prettier
- `npm run format:write` - write formatting with Prettier

## Publishing

`prepublishOnly` runs clean build, typecheck, and tests before publish.

Before first publish, update metadata fields in `package.json`:

- `author`
- `repository.url`
- `bugs.url`
- `homepage`

Then publish:

```bash
npm publish --access public
```

## License

MIT
