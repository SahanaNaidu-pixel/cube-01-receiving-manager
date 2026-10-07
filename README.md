# Receiving Manager

A lightweight receiving-inspection workflow for validating purchase orders against shipment photos, producing structured evidence, and applying a deterministic PASS / EXCEPTION / UNCERTAIN decision.

## Problem statement

A supplier shipment arrives with a purchase order, expected SKU, quantity, variant, carton count and component list. The receiving team needs to confirm what arrived, whether it matches the order, and whether visible damage or missing components create a claimable exception.

## Solution

This app uses:

- FastAPI as the backend API
- Pydantic models for strict inspection contracts
- local image storage for uploaded receiving photos
- optional OpenAI-based multimodal analysis when an API key is configured
- a deterministic Python decision engine for final verdicts
- a React + Vite dashboard for inspection creation, uploads, analysis, and evidence display

## Architecture

```text
React Frontend
  ↓
FastAPI Backend
  ↓
Vision Service
  ↓
Evidence Validation
  ↓
Decision Engine
  ↓
Inspection Result
```

## Features

- Create inspections from a PO payload
- Upload multiple receiving photos
- Validate images by extension, MIME type, content signature, and size
- Keep evidence tied to the correct image and inspection
- Run AI analysis through a structured vision contract
- Demonstrate controlled scenarios in demo mode without an API key
- Return structured checks, evidence, and final decisions
- Let operators override a verdict with a reason (PASS only for approvers)
- Seal evidence records with an HMAC and verify the record chain on demand

## Technology stack

- Python 3.12+ (the backend Docker image uses `python:3.12-slim`)
- FastAPI
- Pydantic
- SQLite (file-backed) for inspections and sealed evidence records
- React + Vite (Node 20+)
- OpenAI Python SDK (optional, for live analysis)
- Local filesystem storage for uploads

## Quick start (local demo)

Runs the backend in demo mode with the placeholder keys from `.env.example`. All commands start from the repository root.

**Windows (PowerShell)**

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend/requirements.txt
Copy-Item .env.example .env
uvicorn backend.app.main:app --port 8000
```

**macOS / Linux**

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r backend/requirements.txt
cp .env.example .env
uvicorn backend.app.main:app --port 8000
```

The backend loads the repo-root `.env` automatically (real environment variables take precedence; set `RECEIVING_DISABLE_DOTENV=1` to skip the file). Check it at http://localhost:8000/api/health.

**Frontend** (second terminal, same on every OS):

```bash
cd frontend
npm ci
npm run dev
```

Open http://localhost:5173, paste `change-me-operator-key` into the **Operator API key** field in the top bar and press **Connect**. Use `change-me-approver-key` to act as an approver (only approvers may override a verdict to PASS). The key is kept in the browser's localStorage.

To use a backend somewhere other than `http://localhost:8000`, copy `frontend/.env.example` to `frontend/.env` and set `VITE_API_BASE_URL`. Vite reads env files only from `frontend/`, not from the repo root, so `VITE_*` lines in the root `.env` have no effect on the frontend.

The `change-me-*` keys are public. The backend accepts them only while `DEMO_MODE=true`; with demo mode off, any `change-me` key in `RECEIVING_API_KEYS` makes the inspection endpoints answer 503 until you replace it.

## Running tests

```bash
python -m pytest backend/tests -q
```

The tests use a temporary database and upload directory and ignore your `.env`.

## Configuration

Backend settings are read from environment variables (or the repo-root `.env`); see `backend/app/core/config.py`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEMO_MODE` | `false` | `true` simulates perception by scenario instead of calling a model (see [Demo mode](#demo-mode)). Never enable in production. |
| `RECEIVING_API_KEYS` | empty | JSON map of API key to `{"organization_id", "operator_id", "role"}`, role `operator` or `approver`. Empty means every `/api/inspections*` call returns 503. |
| `RECEIVING_SEAL_KEY` | empty | HMAC key used to seal evidence records. If empty, a random per-process key is used and `/verify` fails for records sealed before a restart. |
| `AI_API_KEY` / `OPENAI_API_KEY` | empty | Model API key for live analysis; `AI_API_KEY` wins if both are set. |
| `AI_MODEL` (fallback `OPENAI_MODEL`) | `gpt-4o-mini` | Vision model name. |
| `OPENAI_BASE_URL` | empty | Optional OpenAI-compatible endpoint. |
| `AI_TIMEOUT_S` | `45` | Model request timeout in seconds. |
| `DATABASE_URL` | `sqlite:///./receiving_manager.db` | Only file-backed `sqlite:///path` URLs are supported; relative paths resolve against the repo root. |
| `UPLOAD_ROOT_DIR` | `uploads` | Directory for uploaded photos (relative to the working directory). |
| `MAX_IMAGE_SIZE_MB` | `10` | Per-image size limit. |
| `UPLOAD_MAX_IMAGES` | `20` | Maximum images per inspection. |
| `ALLOWED_IMAGE_TYPES` | `image/jpeg,image/png,image/webp` | Accepted MIME types. |
| `ALLOWED_EXTENSIONS` | `.jpg,.jpeg,.png,.webp` | Accepted file extensions. |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000` | Comma-separated browser origins allowed to call the API. |
| `FASTAPI_HOST` / `FASTAPI_PORT` | `0.0.0.0` / `8000` | Used only by `python -m backend.app.main`; with `uvicorn`, pass `--host` / `--port`. |
| `APP_NAME` | `receiving-manager` | Internal service name. |
| `RECEIVING_DISABLE_DOTENV` | unset | Set to `1` to skip loading `.env` (the tests do this). |

Frontend (build time, in `frontend/.env`; see `frontend/.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `http://localhost:8000` | Backend base URL. |
| `VITE_RECEIVING_API_KEY` | empty | Dev-only fallback key. It is baked into the bundle and readable by anyone; do not set it for deployments. |

## Production notes

- Set `DEMO_MODE=false`. In demo mode the caller picks the outcome via `?scenario=`, so results prove nothing.
- Replace the `change-me-*` keys with generated ones, one per operator, e.g. `python -c "import secrets; print(secrets.token_urlsafe(24))"`. Give the `approver` role only to people allowed to release an inspection as PASS.
- Set `RECEIVING_SEAL_KEY` to a generated secret (same command). Keep it outside the database and keep it stable: records sealed under an old key stop verifying.
- Configure `AI_API_KEY` (or `OPENAI_API_KEY`) for live analysis. Without a working model, analysis ends in `PENDING_REVIEW`.
- Set `CORS_ALLOWED_ORIGINS` to the deployed frontend origin(s) only.
- Keep `.env` out of version control and out of images (it is listed in `.dockerignore`); pass settings with `--env-file` or your platform's secret store.
- The SQLite database and `uploads/` are runtime data; put them on persistent storage.

## Deployment

The backend and frontend deploy separately, either as containers or as a static build plus an API host.

Backend container (build context is the repo root):

```bash
docker build -t receiving-manager-backend .
docker run --rm -p 8000:8000 --env-file .env receiving-manager-backend
```

Frontend container (build context is `frontend/`; the backend URL is inlined at build time):

```bash
docker build --build-arg VITE_API_BASE_URL=https://your-backend-domain.com -t receiving-manager-frontend frontend
docker run --rm -p 80:80 receiving-manager-frontend
```

Static build without Docker: `cd frontend && npm ci && npm run build` writes `frontend/dist/` (build output, not committed). Set `VITE_API_BASE_URL` when building, then serve the folder from any static host.

## Demo mode

When `DEMO_MODE=true`, perception is simulated: no API key or real photo content is needed, but every analysis still requires at least one uploaded image. Choose the outcome with `POST /api/inspections/{inspection_id}/analyze?scenario=<name>`:

- `correct_shipment`
- `short_shipment`
- `wrong_variant`
- `damaged_carton`
- `water_damage`
- `missing_component`
- `barcode_glare`
- `ambiguous`
- `perception_failure` (simulates a model failure and yields `PENDING_REVIEW`)

The simulated readings describe SKU `BLUE-BOTTLE-001` (the PO-9001 preset in the UI), so run scenarios against that PO to get the intended verdicts. The UI's Scenario Benchmark view runs all of them. Demo output is labeled in the UI and must not be mistaken for real AI output.

## API overview

Every `/api/inspections*` call needs an `X-API-Key` header with a key from `RECEIVING_API_KEYS`. A missing or unknown key gets 401; no configured keys (or placeholder keys outside demo mode) get 503. Data is scoped to the key's organization.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | No auth. |
| GET | `/api/inspections` | List the organization's inspections. |
| POST | `/api/inspections` | Body `{"po": {...}}` with `po_id`, `sku`, `product_name`, `expected_quantity`, `variant`, `units_per_carton`, `expected_cartons`, optional `expected_components`. |
| GET | `/api/inspections/{inspection_id}` | Inspection with checks, evidence and decision. |
| POST | `/api/inspections/{inspection_id}/images` | Multipart: one or more `files` parts plus `image_type` (`pallet`, `carton`, `label`, `unit`, `other`). |
| GET | `/api/inspections/{inspection_id}/images/{image_id}` | Returns the stored image. |
| POST | `/api/inspections/{inspection_id}/analyze` | Runs analysis; optional `?scenario=` in demo mode. Needs at least one image. |
| POST | `/api/inspections/{inspection_id}/override` | Body `{"decision": "PASS", "reason": "..."}`; decision is `PASS`, `EXCEPTION` or `UNCERTAIN`. PASS needs the `approver` role (403 otherwise); 409 before the inspection has been analyzed. |
| GET | `/api/inspections/{inspection_id}/verify` | Re-checks the seals and hash chain of the stored evidence records. |

FastAPI also serves interactive API docs at http://localhost:8000/docs.

## AI workflow

- load inspection photos from the storage layer
- validate image availability and ownership
- submit PO context and image metadata to the model
- require structured JSON output
- validate the AI response against a strict Pydantic contract
- create evidence records and deterministic checks
- let the Python decision engine resolve the final verdict

## Decision logic

The final verdict is determined by deterministic Python logic, not by the LLM. Each check resolves to `PASS`, `FAIL`, `UNCERTAIN` or `NOT_REQUIRED`, and the inspection decision is:

- `EXCEPTION` if any required check fails
- `UNCERTAIN` if no check fails but any required check is uncertain
- `PASS` if all required checks pass
- `PENDING_REVIEW` if perception itself failed (model unavailable, timeout, invalid output): nothing was checked, so the inspection is held for a person instead of guessed

An operator can override the verdict with a reason; the override is stored as a new sealed record version chained to the previous one, so the original verdict is never overwritten. Details: [DECISION_LOGIC.md](DECISION_LOGIC.md).

## Evidence model

Every evidence item points back to a source image and stores:

- evidence id
- image id
- check type
- observation
- confidence
- description
- optional bounding region

## Uncertainty handling

The system is deliberately conservative:

- unobservable quantities become `UNCERTAIN`
- ambiguous variants become `UNCERTAIN`
- damaged cartons must be clearly visible to trigger `FAIL`
- missing components are only reported when visible evidence supports the finding

## Security

See [SECURITY.md](SECURITY.md) for the full picture, including API-key tenancy and record sealing.

The upload pipeline validates:

- extension and MIME type
- file signature and image contents
- file size limits
- inspection-scoped storage paths
- path traversal prevention
- maximum file counts per inspection

## Limitations

- Storage is a single SQLite file plus local disk for photos; that suits one instance, not a scaled multi-node deployment.
- Live vision analysis requires a valid model API key. Its accuracy on real warehouse photos has not been measured; the scenario benchmark only exercises the decision logic on simulated readings.
- API keys are static entries in `RECEIVING_API_KEYS`; there is no user management or key rotation UI.
- Real warehouse workflows, historical dashboards, and object-storage migration are still future work.
- Demo mode is not a substitute for live multimodal inference.

## Future improvements

- move to a server database (e.g. PostgreSQL)
- add object storage and indexing
- add richer OCR and product matching
- extend the override flow into a full review queue with e-signature
- add analytics and trend reporting across inspections
