# Research Similarity Finder

MERN project foundation. Domain schemas and application features will be designed next.

## Structure

```text
prototype/
  client/                      React view layer (Vite)
    src/
      assets/
      components/
      hooks/
      pages/
      services/                Frontend API clients
      styles/
      App.jsx
      main.jsx
  server/
    scripts/check-db.js         Connection and ping check
    src/
      config/                  Environment and MongoDB connection
      controllers/             HTTP request/response handlers
      middlewares/             Shared request/error handling
      models/                  Reserved for agreed Mongoose schemas
      routes/                  Express routes
      services/                Business logic and future ranking engine
      utils/
      app.js                   Express application
      server.js                Startup and shutdown
  scripts/setup-env.js
  .env.example
  compose.yaml
  package.json
```

MVC mapping: Mongoose models are the model layer, Express controllers handle requests, and React is the view layer. Routes connect endpoints to controllers; services hold business logic outside controllers.

## Requirements

- Node.js 24 or newer and npm.
- Docker Desktop running with its Linux container engine for local MongoDB, or an existing MongoDB connection URI.

## Local setup

Run these commands from `prototype`:

```sh
npm install
npm run setup
npm run db:up
npm run db:check
npm run dev
```

On Windows PowerShell, use `npm.cmd` if the execution policy blocks `npm.ps1`.

- Web app: http://127.0.0.1:5173
- API health: http://127.0.0.1:5000/api/health
- MongoDB target database: `research_similarity`

`npm run setup` creates an ignored root `.env` with a random local password. It never overwrites an existing `.env`. The server reads that root file regardless of the working directory. Vite proxies `/api` to Express; database credentials are not exposed to the browser.

The Compose MongoDB service is bound only to `127.0.0.1` and persists data in a Docker volume. Its bootstrap account is for local development. Use a database-scoped application account when configuring a hosted deployment. MongoDB bootstrap credentials apply only when the volume is first initialized; changing `.env` does not change an existing database user's password. Keep the matching `.env` when reusing that volume.

For an existing MongoDB installation or Atlas, set `MONGODB_URI` in `.env` and skip `npm run db:up`.

No domain models, collections, or seed records are created yet. MongoDB materializes the named application database when its first collection/data is created after schema design. `db:check` verifies authentication and a real MongoDB ping without creating application data.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run API and React dev server together |
| `npm run dev:server` | Run only the API with Node watch mode |
| `npm run dev:client` | Run only Vite |
| `npm run db:up` | Start MongoDB and wait for its health check |
| `npm run db:check` | Verify the configured MongoDB connection |
| `npm run db:down` | Stop/remove the project container while preserving its data volume |
| `npm run build` | Build the React app |
| `npm start` | Run only the API without watch mode |

The API starts listening only after MongoDB connects. `/api/health` returns HTTP 200 when connected and HTTP 503 when disconnected. Unknown routes and request errors return JSON. The React production build is separate from the API and can be served behind a reverse proxy when deployment is planned.
