# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mapbox GL JS is a JavaScript library for interactive, customizable vector maps on the web. It uses WebGL to render vector tiles that conform to the Mapbox Vector Tile Specification.

## Workflow
- Make changes as concise as possible, ensure they are minimal and fully justified
- Read and understand relevant files before proposing code edits. If the user references a specific file/path, inspect it before explaining or proposing fixes.
- Understand WHY code exists before changing it. GL JS handles browser quirks, performance hacks, and WebGL state subtleties. Non-obvious patterns often exist for a reason—check git blame when in doubt.
- Avoid over-engineering. Only make changes that are directly requested or clearly necessary.
  - Don't add features, refactor code, or make "improvements" beyond what was asked
  - Don't create helpers or abstractions until you see repetition
  - Straightforward repetition beats unclear abstraction
- Always run `npm run tsc` and `npm run lint` when you're done making a series of code changes
- Run `npm run codegen` if you modify style properties or the style specification (regenerates style code, struct arrays, and TypeScript types)
- Run `npm run test-typings` after modifying public API types or the style specification
- Prefer running single tests, and avoid running the whole test suite, for performance
- Never add any dependencies unless explicitly requested

## Essential Commands

### Development
```bash
# Start development server with live reload
npm run start

# Build development version (ESM)
npm run build-esm-dev

# Build production bundles
npm run build-esm-prod  # Minified ESM production build
npm run build-prod  # Minified UMD production build
npm run build-css       # Build CSS file

# Generate code (style code, struct arrays, and TypeScript types)
npm run codegen
```

### Testing
```bash
# Test TypeScript definitions
npm run test-typings

# Run unit tests
npm run test-unit

# Run unit tests for specific file
npm run test-unit -- test/unit/style-spec/spec.test.ts

# Run specific test inside a file (use -t with test name pattern)
npm run test-unit -- test/unit/style/style.test.ts -t 'Style#addImage'

# Run render tests with pattern matching (matches test path segments)
npm run test-render -- -t "background-color"

# Regenerate expected.png baselines (inspect diffs before committing!)
UPDATE=1 npm run test-render -- -t "<pattern>"
```

Render tests:
- Test name = folder path under `test/integration/render-tests/` (e.g. `circle-radius/literal`). `-t` is Vitest's substring pattern, so `-t "circle"` also hits `circle-color`, `circle-blur`, etc. — add a slash to narrow: `-t "circle-radius/"`
- Always use `npm run test-render`, not `npx vitest` — the `pretest` hook rebuilds `dist/mapbox-gl-dev.js` and pmtiles
- Inspect diffs: `open test/integration/render-tests/render-tests.html`
- Platform-specific failures → `test/ignores/<platform>.js` (prefer `todo` over `skip`, link the issue)

### Code Quality
```bash
# Type checking
npm run tsc

# Run ESLint
npm run lint

# Run CSS linter
npm run lint-css
```

## Architecture Overview

For detailed architecture documentation including Map subsystems, SourceCache, Transform, and Controls, see [@ARCHITECTURE.md](./ARCHITECTURE.md).

### Main Thread / Worker Split

Mapbox GL JS uses WebWorkers to parse vector tiles off the main thread:

1. **Main Thread**: Handles rendering, user interactions, and map state
2. **Worker Threads**: Parse vector tiles, perform layout operations, and prepare render-ready data

### Rendering Pipeline

1. **Tile Fetching & Parsing** (Worker)
   - Vector tiles are fetched and deserialized from PBF format
   - Features are transformed into render-ready WebGL buffers
   - Feature geometries are indexed for spatial queries

2. **Layout Process** (Worker)
   - `WorkerTile#parse()` creates `Bucket` instances for style layer families
   - Each `Bucket` holds vertex and element array data for WebGL rendering
   - `ProgramConfiguration` handles shader attribute/uniform configuration

3. **WebGL Rendering** (Main Thread)
   - Rendering happens layer-by-layer in `Painter#render()`, `Painter.renderPass` tracks the current render phase
   - Layer-specific `draw*()` methods in `src/render/draw_*.ts`
   - Shader programs are compiled and cached by `Painter`

### Key Components

- **Map**: Central class managing the map instance
- **Style**: Manages map styling and layer configuration
- **SourceCache**: Manages tile loading and caching
- **Transform**: Handles map positioning and projections
- **Painter**: WebGL rendering orchestration

## Project Structure

```
3d-style/          # 3D building and model rendering

src/
├── data/          # Data structures for tiles and rendering
├── geo/           # Geographic calculations and transformations
├── gl/            # WebGL abstraction layer
├── render/        # Rendering implementation
├── shaders/       # GLSL shaders with custom #pragma directives
├── source/        # Tile source implementations
├── style/         # Style layer implementations
├── style-spec/    # Mapbox Style Specification (separate workspace)
├── symbol/        # Text and icon rendering
├── terrain/       # 3D terrain rendering
├── ui/            # User interaction handlers
└── util/          # Utility functions

test/
├── unit/          # Unit tests (Vitest)
├── integration/   # Integration and render tests
└── build/         # Build-related tests
```

## Code Style

- ES6+ features are used throughout
- Prefer immutable data structures
- Prefer named exports over default exports
- Modules export classes or functions (no namespace objects)
- JSDoc comments for all public APIs
- Don't use `!.` for non-null assertions (hides potential null issues)
- Don't use `?.` or `??` operators (hides null handling, harder to debug)
- Use `assert` for invariants
- Break complex expressions into named variables, especially WebGL math
- Object spread (`{...obj}`) is banned, use `Object.assign()` instead
- Use `import type` for type-only imports
- No TODO/FIXME comments in committed code

## TypeScript

- The project has TypeScript configured with `strict: false`, but write all TypeScript code as if strict mode is enabled
- This means: always handle `null`/`undefined` cases, use proper type annotations, avoid `any` types, and ensure type safety
- Prefer explicit return types over `// @ts-expect-error` suppressions for functions that may not return a value
- Prefer literal unions over boolean flags; allows future extension without breaking changes

## Testing Guidelines

- Tests use Vitest framework with Playwright as the browser provider
- Install Playwright browsers: `npx playwright install chromium`
- Any PR that changes rendering behavior (shader changes, draw function logic, bucket data changes) must include a render test in `test/integration/render-tests/`
- For query behavior changes, add corresponding query tests covering all affected layer types
- Render tests for bug fixes must fail without the fix; a tolerance loose enough to pass either way is useless
- Every render test `style.json` must include a `_comment` field explaining what it checks; drop unused intermediate `wait` steps
- Don't inflate render test tolerance to make a failing test pass — investigate the root cause
- Size render test expected images to the minimum needed (e.g., 32×64, not 128×128)

### Writing Unit Tests

- No shared variables between test cases
- Don't mock internal domain objects (Style, Map, Transform, Dispatcher)
- One return value or side effect per test - pull shared logic into functions
- Only test return values and global side effects - not internal behavior or method calls
- No network requests - use `mockFetch` from `test/util/network.ts` if needed
- Use clear input space partitioning - look for edge cases

## Documentation Conventions

- All public API must have JSDoc comments; private items tagged with `@private`
- Use markdown in JSDoc; surround code identifiers with \`backticks\`
- Class descriptions: describe what the class/instances *are* (e.g., "A layer that...")
- Function descriptions: start with third-person verb (e.g., "Sets...", "Returns...")
- For functions returning values, start with "Returns..."
- Event descriptions: start with "Fired when..."
- Style-spec `doc` fields in `v8.json` render verbatim in the public API reference — use unambiguous language, avoid internal terms, and don't reference implementation details
- When adding a new property to `v8.json`, populate the `sdk-support` table and set `experimental: true` until release version is confirmed

## WebGL and Shaders

- Custom `#pragma mapbox` directives in shaders expand to uniforms or attributes
- Shader programs are dynamically generated based on style properties
- Data-driven styling creates paint vertex arrays at layout time
- See [@src/shaders/README.md](src/shaders/README.md) for shader documentation
- Use named `#define` constants for integer mode values in shaders — never bare magic numbers like `if (u_blend_mode == 1)`
- Use `#if defined(A) && defined(B)` for compound shader conditionals (not `#ifdef`); required for the Metal preprocessing pipeline

## Performance

- Allocate GPU objects (buffers, textures, bind groups, UBOs) at bucket creation or style load time; invalidate only when underlying data changes. **Never allocate GPU objects inside draw functions that run every frame.**
- In hot paths, prefer flat typed arrays (`Float32Array`, `Uint16Array`) over arrays of objects or nested arrays
