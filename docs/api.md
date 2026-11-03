## Researcher API example

Start MongoDB, then run `npm.cmd run dev:server` from the project root.
These are local-development endpoints without authentication; do not expose them publicly.
Publication endpoints are intentionally left unimplemented as a learning exercise.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/researchers?page=1&limit=20` | List researchers, newest first (maximum limit 100) |
| GET | `/api/researchers/:id` | Fetch one researcher by MongoDB `_id` |
| POST | `/api/researchers` | Create a researcher; return 201 and a Location header |

In a second PowerShell terminal:

```powershell
$body = @{
  name = 'Example Researcher'
  biography = 'Works on medical image analysis.'
  researchInterests = @('Deep Learning', 'Computer Vision')
  affiliations = @(@{ institution = 'Example University'; countryCode = 'NZ' })
} | ConvertTo-Json -Depth 5

$created = Invoke-RestMethod -Method Post `
  -Uri 'http://127.0.0.1:5000/api/researchers' `
  -ContentType 'application/json' -Body $body
$created.data

Invoke-RestMethod 'http://127.0.0.1:5000/api/researchers?page=1&limit=20'
Invoke-RestMethod "http://127.0.0.1:5000/api/researchers/$($created.data._id)"
```

Responses wrap the record/list in `data`. POST requires a non-blank string `name`;
it accepts `externalIds`, `biography`, `affiliations`, `researchInterests` and `profileUrl`.
IDs, timestamps and sync metadata cannot be supplied through this endpoint.
Mongoose validates schema fields. Invalid input returns 400, a missing record 404,
and duplicate unique IDs 409 (run `npm run db:indexes` to enforce uniqueness).

Request flow: `app.js` mounts `/api`, `routes/index.js` mounts `/researchers`,
`researcher.routes.js` selects the controller, and `researcher.controller.js` calls
the Researcher model. Express 5 forwards rejected async controllers to the shared
error middleware. Use this pattern to write the Publication controller and routes.

