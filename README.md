# CUBE Receiving Manager

An AI-assisted receiving-inspection agent for the CUBE multi-agent ecosystem. It checks an inbound delivery against its purchase-order line using photos and operator counts. A vision model, when one is configured, only reports what it sees. Deterministic Python rules decide PASS / FAIL / UNCERTAIN for each check. The result is sealed as a tamper-evident `receiving_record.v1` that downstream agents (Prep, Recovery, Returns, Pack) can fetch and verify over the `cube.a2a.v1` protocol.

## What it does without a vision key

The agent never accepts a shipment it could not verify:

- With no AI key configured (`VISION_PROVIDER=auto` and no key, or `VISION_PROVIDER=none`), the vision provider is `none`. Readiness reports `vision_provider: DEGRADED` with the message **"Vision analysis unavailable — manual review required."**
- A run with photos but no operator readings gets every perception check `UNCERTAIN` (`PERCEPTION_UNAVAILABLE`) and the verdict `PENDING_REVIEW`. A review task is opened. The record is still sealed with `status: "pending"` (contract rule 3, "fail open, not fail accept").
- **Operator counts are human evidence.** If the operator enters manual observations (SKU, counts, variant, damage, components), those readings are decided by the same rules as model readings (source `operator`, confidence 1.0). Checks with no operator reading stay `UNCERTAIN`. The verdict is computed normally, so an operator count that contradicts the PO gives FAIL, and a full set of matching operator readings can give PASS.
- The operator-reported carton condition check (seal / visible condition from intake) runs whether or not vision is available.

## Features by page

The frontend is a single-page app at `#/app/<page>`. Every figure comes from the API; there is no mock data.

| Page | What it does |
| --- | --- |
| **Dashboard** | Totals for a date window (today / 7d / 30d / all / custom): inspections by verdict, open issues and reviews, discrepancy counts by type, a daily verdict chart, issues by reason code, recent inspections, recent agent activity and the `/ready` result. Tiles and bars deep-link into the filtered lists. |
| **Inspections** | Every inspection in the organisation. Search and filter by verdict, status, supplier, SKU, PO, shipment, open issues and date, with sorting and pagination. The detail page has tabs for Overview, Checks, Evidence, Issues, Reviews, Audit and Record (the sealed JSON). Actions: re-run, request review, override, add note, hand off to another agent, verify integrity, export (JSON / CSV / HTML). |
| **New Inspection** | A 7-step wizard: 1 Shipment / PO, 2 Product, 3 Cartons (seal and visible condition per carton), 4 Evidence (photo upload by view: pallet, carton, unit, label, other), 5 Inspection (operator manual observations; demo scenario when `DEMO_MODE=true`; run), 6 Verdict, 7 Review. POs and products can be picked from the catalogue to prefill expected values. |
| **Review Queue** | Review tasks opened when a run ends UNCERTAIN or PENDING_REVIEW, or requested manually. The detail page shows the automated result next to the evidence. A reviewer records a human decision (PASS / FAIL / UNCERTAIN with a note; PASS needs the approver role), requests more evidence, assigns, or adds notes. The machine result stays in the sealed record. |
| **Exceptions** | One issue per FAIL or UNCERTAIN check per run. Lifecycle: open → in_review → resolved (reopen allowed), plus assign, notes and linking more evidence photos. A new run supersedes the previous run's open issues. |
| **Purchase Orders** | Catalogue POs plus POs seen only on inspections. Received quantity, discrepancy (none / short / over / unverified) and status are derived from analysed inspections. Create POs, or import a CSV or the bundled sample. |
| **Shipments** | Grouped from the shipment details captured on inspections (shipment ID, supplier, ASN, warehouse), with verdict counts. |
| **Products** | The SKU catalogue (name, variant, colour, units per carton, expected components, supplier). Create, edit and import. |
| **Cartons** | Cartons declared at intake, with observed units per carton (operator count first, else vision) and the photos tagged `carton`. |
| **Evidence** | Every uploaded photo with SHA-256 digest, source (`upload` / `a2a`), uploader, analysis status, readings, linked checks and issues. The detail page can re-hash the downloaded file in the browser and compare digests. |
| **Audit Trail** | The append-only audit events (who did what, to which entity, through which channel, with request and correlation ids). |
| **Agent Activity** | Persisted inbound and outbound `cube.a2a.v1` traffic with request and response envelopes (image bytes stripped). |
| **A2A Integration** | Tabs: **Message console** (build and send real envelopes to `POST /api/agent/receive`), **Guided demo** (four real requests sharing one correlation id: read the agent card, `agent.ping`, `receiving.inspect` with an attached photo, `receiving.verify_record`), **Agent card**, and **Scenario regression (demo mode only)**. The regression runs every backend demo scenario against the PO-9001 reference line and compares the decision with the expected one. It checks the rules over simulated perception and is not a measure of vision accuracy. It refuses to run unless `GET /health` reports `demo_mode: true`, so placeholder images never reach a live model. |
| **System Health** | Live probes from the browser: connectivity and latency to `/api/ready`, liveness (`/api/health`), each readiness component, and the API-key check (`/api/system/info`). |
| **Settings** | Operator API key (stored in this browser's localStorage), theme, which backend URL the build talks to, and the backend configuration reported by `/api/system/info`. |
| **Help** | Workflow, verdict mapping, decision rules, issue and review lifecycles, A2A summary, keyboard shortcuts and troubleshooting. |

## Quick start (local)

Python 3.12+ and Node 20+. All commands start from the repository root.

**Backend (Windows PowerShell)**

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend/requirements.txt
Copy-Item .env.example .env
uvicorn backend.app.main:app --port 8000
```

**Backend (macOS / Linux)**

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r backend/requirements.txt
cp .env.example .env
uvicorn backend.app.main:app --port 8000
```

The backend loads the repo-root `.env` automatically. Real environment variables take precedence, and `RECEIVING_DISABLE_DOTENV=1` skips the file. Check http://localhost:8000/api/health (liveness) and http://localhost:8000/api/ready (readiness). Interactive API docs are at http://localhost:8000/docs.

**Frontend** (second terminal):

```bash
cd frontend
npm ci
npm run dev
```

Open http://localhost:5173, paste an API key into the key field and press **Connect**. The dev server talks to `http://localhost:8000` unless `frontend/.env` sets `VITE_API_BASE_URL`. Vite reads env files only from `frontend/`, so `VITE_*` lines in the root `.env` have no effect.

### API keys and roles

`RECEIVING_API_KEYS` is a JSON object mapping each key to the principal it authenticates:

```json
{
  "change-me-operator-key": {"organization_id": "org-demo", "operator_id": "op-1",  "role": "operator"},
  "change-me-approver-key": {"organization_id": "org-demo", "operator_id": "sup-1", "role": "approver"},
  "prep-agent-key":         {"organization_id": "org-demo", "operator_id": "prep_manager", "role": "agent"}
}
```

- `operator` can create, upload, run, request review, add notes, hand off, and override or decide to FAIL / UNCERTAIN.
- `approver` can do all of that and is the only role that may finalise PASS (override or review decision).
- `agent` is for other CUBE agents calling over A2A. It is treated like an operator (it cannot finalise PASS). An unknown role falls back to `operator`.

The `change-me-*` keys in `.env.example` are public. They are accepted only while `DEMO_MODE=true`. With demo mode off, any key starting `change-me` makes every authenticated route answer 503. Generate real keys with `python -c "import secrets; print(secrets.token_urlsafe(24))"`.

### Importing the sample catalogue

On **Purchase Orders** or **Products**, choose **Import catalogue**, then either upload a CSV with the columns of `data/receiving_sample.csv` or import the bundled sample. Over the API, send `POST /api/catalogue/import` with JSON `{"source": "sample"}` or a multipart `file`. The sample is synthetic (see `data/README.md`). All of its rows, whichever `org_id` they carry, are imported into the caller's organisation as products and PO lines.

### Demo mode

`DEMO_MODE=true` (the `.env.example` default) replaces vision with scripted readings, so the caller chooses the outcome. Do not use it for real receiving. Every run still needs at least one uploaded image (any valid JPEG / PNG / WebP), and the readings are attached to that image. Pick the scenario in step 5 of the wizard, with `?scenario=` on the run endpoint, or with `scenario` in the run body or the A2A `receiving.inspect` payload:

`correct_shipment` (default), `short_shipment`, `wrong_variant`, `damaged_carton`, `water_damage`, `missing_component`, `barcode_glare`, `ambiguous`, `perception_failure` (simulates a model failure, which gives `PENDING_REVIEW`).

The scripted readings describe SKU `BLUE-BOTTLE-001`, variant Blue, 2 cartons × 12 = 24 units, components `cap` and `label` (the PO-9001 reference line). Run them against that PO line to get the intended verdicts. Demo output is labelled in the UI and in the record (`model_version: "demo"`).

## Configuration

Backend settings come from environment variables or the repo-root `.env` (`backend/app/core/config.py`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEMO_MODE` | `false` | `true` simulates perception by scenario and allows the public `change-me` keys. `.env.example` sets it to `true`. Never enable in production. |
| `VISION_PROVIDER` | `auto` | `auto` \| `openai` \| `demo` \| `none`. `auto` = `demo` if `DEMO_MODE`, else `openai` if an AI key is set, else `none`. `demo` without `DEMO_MODE` falls back to `none`. |
| `AI_API_KEY` / `OPENAI_API_KEY` | empty | Model API key; `AI_API_KEY` wins if both are set. |
| `AI_MODEL` (fallback `OPENAI_MODEL`) | `gpt-4o-mini` | Vision model name. |
| `OPENAI_BASE_URL` | empty | Optional OpenAI-compatible endpoint (Responses API with strict JSON schema output). |
| `AI_TIMEOUT_S` | `45` | Model request timeout in seconds (the client also retries twice). |
| `DAMAGE_POLICY` | `fail` | `fail` \| `review`. Under `review`, visible damage and operator-reported carton damage give UNCERTAIN (`DAMAGE_REVIEW_REQUIRED`) instead of FAIL. Any other value means `fail`. |
| `RECEIVING_API_KEYS` | empty | JSON map of API key → `{organization_id, operator_id, role}` (see above). Empty or malformed → every authenticated route answers 503. |
| `RECEIVING_SEAL_KEY` | empty | HMAC key that seals records. Empty → a random per-process key (logged warning, readiness `seal_key: DEGRADED`), and records sealed before a restart no longer verify. |
| `DATABASE_URL` | `sqlite:///./receiving_manager.db` | Only file-backed `sqlite:///path` URLs. Relative paths resolve against the repo root. |
| `UPLOAD_ROOT_DIR` | `uploads` | Directory for uploaded photos (relative to the working directory). |
| `MAX_IMAGE_SIZE_MB` | `10` | Per-image size limit. |
| `UPLOAD_MAX_IMAGES` | `20` | Maximum images per inspection (and per A2A `receiving.inspect`). |
| `ALLOWED_IMAGE_TYPES` | `image/jpeg,image/png,image/webp` | Accepted MIME types (content is checked by magic bytes). |
| `ALLOWED_EXTENSIONS` | `.jpg,.jpeg,.png,.webp` | Accepted file extensions. |
| `A2A_PEERS` | empty | Outbound hand-off targets: `{"prep_manager": "https://…/api/agent/receive"}` or `{"prep_manager": {"url": "https://…", "api_key": "…"}}`. Unconfigured targets are recorded as `not_configured`, never as delivered. |
| `AGENT_ID` | `receiving_manager` | This agent's id in the agent card and in envelopes. |
| `APP_VERSION` | `1.0.0` | Version reported by `/health`, the agent card and envelopes. |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000` | Comma-separated browser origins allowed to call the API. |
| `FASTAPI_HOST` / `FASTAPI_PORT` | `0.0.0.0` / `8000` | Used only by `python -m backend.app.main`. With `uvicorn`, pass `--host` / `--port`. |
| `APP_NAME` | `receiving-manager` | Internal service name. |
| `RECEIVING_DISABLE_DOTENV` | unset | Set to `1` to skip loading `.env` (the tests do this). |

Frontend (build time, in `frontend/.env`; see `frontend/.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_API_BASE_URL` | dev server: `http://localhost:8000`; production build: same origin | Backend base URL, inlined at build time. |
| `VITE_RECEIVING_API_KEY` | empty | Dev-only fallback key. It is baked into the bundle and readable by anyone; never set it for a deployment. |

## API overview

- REST reference: [docs/API.md](docs/API.md). It covers inspections, run, override, verify, export, issues, reviews, evidence, catalogue, shipments, cartons, dashboard, audit, health and readiness.
- A2A protocol `cube.a2a.v1`: [docs/A2A.md](docs/A2A.md). It covers the agent card, the `POST /api/agent/receive` envelope, the operations `receiving.inspect`, `receiving.get_record`, `receiving.verify_record` and `agent.ping`, outbound hand-off and the activity log.
- Record contract: `contracts/receiving_record.v1.md`. JSON Schemas for the record and the A2A messages are in `contracts/`.

Public routes: `/health`, `/api/health`, `/ready`, `/api/ready` and `/.well-known/agent.json`. Everything else needs `X-API-Key`, and all data is scoped to the key's organisation. Errors use one envelope, `{"detail", "error": {code, message, request_id, details}}`.

## Testing

```bash
python -m pytest backend/tests -q
```

The backend suite has 113 tests (`backend/tests/test_backend.py`, `test_platform.py`, `test_upgrades.py`). They use a temporary database and upload directory and ignore your `.env`. The live model call is tested only with a mocked client.

## Deployment

The production checklist:

- Set `DEMO_MODE=false` and configure an AI key, or accept that every run without operator readings is held for manual review.
- Generate real API keys and a stable `RECEIVING_SEAL_KEY`, and keep them outside the database and the image.
- Set `CORS_ALLOWED_ORIGINS` to the deployed frontend origin only.
- Put the SQLite file and `uploads/` on persistent storage.

**Docker** (backend; build context is the repo root, `.env` is excluded by `.dockerignore`):

```bash
docker build -t receiving-manager-backend .
docker run --rm -p 8000:8000 --env-file .env receiving-manager-backend
```

The container runs `uvicorn` on `$PORT` (default 8000). The frontend image (`frontend/Dockerfile`, nginx) inlines the backend URL at build time. Always pass it, because the Dockerfile's default build arg is `http://localhost:8000`:

```bash
docker build --build-arg VITE_API_BASE_URL=https://your-backend.example.com -t receiving-manager-frontend frontend
docker run --rm -p 80:80 receiving-manager-frontend
```

**Render** (`render.yaml` Blueprint): a Docker web service `receiving-manager-api` with health check `/health`, `DEMO_MODE=true`, `RECEIVING_API_KEYS` prompted at creation, a generated `RECEIVING_SEAL_KEY` and `CORS_ALLOWED_ORIGINS` set to the static site's URL. The second service is a static site `receiving-manager-web` built with `VITE_API_BASE_URL=https://$API_HOST`, where `$API_HOST` comes from the API service. The free plan's disk is not persistent, so the database and uploads are lost on redeploy.

**Vercel** (`vercel.json` + `api/index.py`): the frontend is built to `frontend/dist`, and the FastAPI app runs as one Python function. `/api/*`, `/health`, `/ready` and `/.well-known/agent.json` are rewritten to it, and everything else goes to `index.html`. With no `VITE_API_BASE_URL`, the production bundle calls the same origin. `api/index.py` defaults `DATABASE_URL` to `/tmp/receiving_manager.db`, `UPLOAD_ROOT_DIR` to `/tmp/uploads` and `DEMO_MODE` to `true` unless they are set. The root `requirements.txt` holds the function's dependencies.

Production frontend builds never fall back to localhost (`services/api.js`). They use `VITE_API_BASE_URL` if it was set at build time, otherwise the page's own origin. Only the Vite dev server defaults to `http://localhost:8000`.

## Known limitations

- **Single-process locks.** Per-inspection mutation locks and the A2A idempotency locks are in-process `threading.Lock`s. Running several workers or hosts needs a database-level guard (for example, a row-version compare-and-swap).
- **SQLite and O(n) filtering.** Storage is one SQLite file plus local disk. List endpoints load every row for the organisation and filter, sort and paginate in Python. Tenancy is enforced in application code (every query is filtered by `organization_id`), not by row-level security.
- **Damage is not split.** The model reports one damage reading, recorded as `carton_damage`. `unit_damage` is never produced, so the dashboard's `damaged_products` stays 0.
- **Vercel storage is ephemeral.** `/tmp` is per-instance and is wiped on cold starts, so inspections, records and photos do not persist reliably there. Records sealed without `RECEIVING_SEAL_KEY` also stop verifying when the instance changes.
- **Perception failure stays PENDING_REVIEW.** When perception fails or is unavailable and the operator entered no readings, the record is `PENDING_REVIEW` (contract rule 3). This holds even if the operator-reported carton condition check FAILs. The FAIL is visible in the checks, issues and agent summary, but the verdict is not escalated to EXCEPTION.
- **Vision accuracy is unmeasured.** No accuracy has been measured on real warehouse photos. The scenario regression only exercises the rules on simulated readings. There is one global confidence threshold (0.6), not one calibrated per check.
- **Whole-shipment overrides only.** Overrides and review decisions apply to the whole shipment; per-check overrides are not offered.
- **No user management.** API keys are static entries in `RECEIVING_API_KEYS`. There is no login, key rotation or rate limiting.

## Further reading

- [ARCHITECTURE.md](ARCHITECTURE.md): layers, data flow, persistence, frontend and A2A
- [DECISION_LOGIC.md](DECISION_LOGIC.md): every check, reason code and the verdict mapping
- [SECURITY.md](SECURITY.md): auth, tenancy, upload validation, sealing, known gaps
- [frontend/src/README.md](frontend/src/README.md): the guide for page builders
