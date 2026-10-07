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

## Technology stack

- Python 3.14
- FastAPI
- Pydantic
- React + Vite
- OpenAI Python SDK (optional, when configured)
- Local filesystem storage for uploads

## Setup

1. Create a virtual environment.
2. Install backend dependencies.
3. Copy `.env.example` to `.env` and fill in the values.
4. Start the backend with uvicorn.
5. Start the frontend with Vite.

## Environment variables

```bash
AI_API_KEY=
OPENAI_API_KEY=
AI_MODEL=gpt-4o-mini
OPENAI_MODEL=gpt-4o-mini
DEMO_MODE=true
MAX_IMAGE_SIZE_MB=10
UPLOAD_MAX_IMAGES=20
ALLOWED_IMAGE_TYPES=image/jpeg,image/png,image/webp
ALLOWED_EXTENSIONS=.jpg,.jpeg,.png,.webp
UPLOAD_ROOT_DIR=uploads
FASTAPI_HOST=0.0.0.0
FASTAPI_PORT=8000
CORS_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,https://your-frontend-domain.com
VITE_API_BASE_URL=http://localhost:8000
```

## Running locally

Backend:

```bash
cd /workspaces/cube-01-receiving-manager
python3 -m venv .venv
. .venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
```

Frontend:

```bash
cd /workspaces/cube-01-receiving-manager/frontend
npm install
npm run dev -- --host 0.0.0.0
```

## Deployment

The app is ready for deployment as a split frontend + backend setup or as containerized services.

Backend container:

```bash
docker build -t receiving-manager-backend .
docker run --rm -p 8000:8000 --env-file .env receiving-manager-backend
```

Frontend static build:

```bash
cd frontend
docker build --build-arg VITE_API_BASE_URL=https://your-backend-domain.com -t receiving-manager-frontend .
docker run --rm -p 80:80 receiving-manager-frontend
```

For production hosting, set the backend `CORS_ALLOWED_ORIGINS` value to your deployed frontend domain and keep `VITE_API_BASE_URL` pointed at the public backend URL.

## Demo mode

When `DEMO_MODE=true`, the backend can run controlled scoring scenarios without a real API key. The current demo scenarios are:

- Correct Shipment
- Short Shipment
- Wrong Variant
- Damaged Carton
- Ambiguous

This is clearly labeled in the UI and should not be mistaken for real AI output.

## API overview

- `GET /api/health`
- `POST /api/inspections`
- `GET /api/inspections`
- `GET /api/inspections/{inspection_id}`
- `POST /api/inspections/{inspection_id}/images`
- `GET /api/inspections/{inspection_id}/images/{image_id}`
- `POST /api/inspections/{inspection_id}/analyze`

## AI workflow

- load inspection photos from the storage layer
- validate image availability and ownership
- submit PO context and image metadata to the model
- require structured JSON output
- validate the AI response against a strict Pydantic contract
- create evidence records and deterministic checks
- let the Python decision engine resolve the final verdict

## Decision logic

The final verdict is determined by deterministic Python logic, not by the LLM.

- if any required check fails, the result is `EXCEPTION`
- if no check fails but any required check is uncertain, the result is `UNCERTAIN`
- if all required checks pass, the result is `PASS`

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

The upload pipeline validates:

- extension and MIME type
- file signature and image contents
- file size limits
- inspection-scoped storage paths
- path traversal prevention
- maximum file counts per inspection

## Limitations

- Local filesystem storage is used for the demo build, not a multi-tenant production database.
- OpenAI vision analysis is optional and requires a valid API key.
- Real warehouse workflows, historical dashboards, and object-storage migration are still future work.
- Demo mode is not a substitute for live multimodal inference.

## Future improvements

- integrate a production database
- add object storage and indexing
- add richer OCR and product matching
- add e-signature or operator review workflow
- add analytics and trend reporting across inspections
