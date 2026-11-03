# Research Atlas frontend

The React/Vite homepage browses the live Otago research collection. It includes weighted literal search, all/any-term matching, quoted phrases, exact identifiers, department/year/type filters, pagination, researcher and publication dialogs, browser-local saved records, and comparison of up to three researchers. Paper Trail adds a separate neural recommendation panel with publication evidence.

The Slate Observatory design uses a navy navigation rail, flowing slate/indigo background light and solid reading surfaces. Two overlapping 44/61-second currents provide subtle ambient movement; a faint light follows fine pointers with a soft lag. The background pauses in hidden tabs and follows the system light/dark appearance.

Publication/profile titles travel into detail dialogs and return to their cards. Save actions send a small paper to the sidebar, and selected researcher avatars dock in the comparison tray before expanding into comparison columns. Search light tracks actual pending requests. Existing results remain dimmed and inert while fetching; matching cards reflow when the response arrives, outgoing cards dissolve and incoming cards settle in. Actions update immediately. Reduced motion disables both CSS and JavaScript effects, removes in-flight decoration, and dismisses dialogs immediately.

From the repository root, run `npm.cmd run dev` (Windows) or `npm run dev` to start the API and client. Open http://127.0.0.1:5173/. If the API is already running, start only the client with `npm.cmd run dev:client`.

## Data and state

- The normal homepage uses real API records. Empty and unavailable collections have distinct states with refresh/retry actions.
- `?demo=1` opens a clearly labelled, fictional sample collection. Samples are browser-only and are never inserted into MongoDB.
- Search, all/any matching, academic unit, exact year or year range, publication type, researcher scope, sorting, result type and pagination live in URL parameters. Browser Back and refresh restore them. A changed query defaults to Most relevant; an explicit sort survives filter and page changes.
- The live UI preserves the backend's result order. Researcher cards preview the top matching paper; profile details show up to three evidence papers and why the record matched. Scores are ranking points, never percentages.
- Year/type filters apply to both result kinds; researcher results must have a qualifying matching publication. A year range is inclusive and is never sent together with an exact year.
- Saves use local storage, separated into live and sample collections. They persist in the current browser; there is no account sync.
- Query-specific scores, matching-paper evidence and duplicate grouping IDs are excluded from new saved snapshots. Saved views do not display stale search explanations.
- Profile and paper details open in accessible native dialogs. These can become dedicated pages later.
- Researcher publication counts describe the imported collection, not complete career output.
- Publication department filters use the current affiliations of linked researchers, not historical publication affiliations.

## Read-only API additions

`GET /api/discovery/summary` returns researcher/publication counts, current academic units and available years.

`GET /api/discovery` accepts `kind` (`researchers` or `publications`), `q`, `match` (`all` or `any`), `department`, `researcher`, `year` OR `yearFrom`/`yearTo`, `type`, `page`, and `limit` (maximum 24). Researcher sorts: `relevance`, `name`, `recent`. Publication sorts: `relevance`, `newest`, `oldest`, `title`. An exact researcher ID identifies a profile or restricts publication authors. Department and researcher constraints intersect.

The result envelope is `{ data, total, page, limit, pages, search }`. Results expose `searchMatch`; publications also expose `publicationUrl` and `duplicateRecordIds`. Researchers include `publicationCount`, `latestPublication`, `matchedPublicationCount` and `matchingPublications`. Collection/lifetime counts are stored-record counts; result totals reflect the backend's conservative grouping, not a guarantee of exhaustive distinct-work identification.

Manual matching is literal and case-insensitive. The default requires every clause in one document; quoted phrases must occur within one field value. Live weighting, researcher-paper linking and ranking stay in the API. Semantic recommendations use the separate model-backed endpoint. The clearly labelled sample view reuses the pure `@research-atlas/search` package, never database models or connections. Validation (400), overly broad queries (422) and temporary timeouts (503) show safe messages.

## Code map

- `src/App.jsx`: application shell, navigation, comparison and dialog coordination.
- `src/features/recommendations/`: Paper Trail component and styles.
- `src/pages/ExplorePage.jsx`: homepage search, filters and result states.
- `src/components/ResearchCards.jsx`: shared researcher/publication cards.
- `src/components/ResearchDialog.jsx`: detail and comparison dialogs.
- `src/components/AmbientBackground.jsx`: slow background currents and pointer light.
- `src/components/MotionList.jsx`: measured result reflow and removal focus restoration.
- `src/hooks/`: cancellable requests, URL state and saved records.
- `src/services/research-api.js`: API access and safe external links.
- `src/services/explorer-state.js`: validated URL state, query-aware sort defaults and API parameter mapping.
- `src/services/sample-data.js`: fictional preview records, loaded only in sample mode.
- `src/services/motion.js`: cancellable title, paper and avatar effects.
- `src/styles/global.css`: responsive styling, focus states and reduced-motion support.
- `src/styles/motion.css`: ambient light, motion overlays and reduced-motion fallbacks.

## Verification

From the repository root:

```sh
npm run build
npm run test:discovery --workspace @research-atlas/web
node --test --test-isolation=none apps/api/tests/discovery.routes.test.js apps/api/tests/researcher.routes.test.js apps/api/tests/models.test.js
```

`node apps/web/tests/homepage.browser.mjs` runs browser checks against the local dev server and a populated live collection. It requires Playwright and a browser (Edge on Windows). `PLAYWRIGHT_MODULE` can point to an existing Playwright package; `PREVIEW_URL` overrides the URL, and `QA_OUTPUT_DIR` optionally captures screenshots. Browser checks use an isolated profile and do not write to the application database.

`node apps/web/tests/motion.browser.mjs` checks the creative motion flows, focus restoration, controlled pending requests and reflow, mobile layouts, and reduced-motion cleanup using isolated sample/fixture data.

`node apps/web/tests/discovery.browser.mjs` verifies live server ordering, automatic relevance, explicit-sort persistence, all/any and phrases, inclusive year ranges, researcher evidence, safe links, Back/reload, saved-snapshot cleanup, validation/limit errors and 320–1440px layouts. It uses the same Playwright/URL/output settings and an isolated browser profile; API calls remain read-only.
