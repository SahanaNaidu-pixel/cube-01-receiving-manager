/*
 * New inspection — 7-step wizard: shipment/PO → product → cartons → evidence → run → verdict → review.
 *
 * URL state (hash query): ?step=<1..7>&id=<draft inspection id>. The inspection is created (POST /api/inspections)
 * when leaving step 3; from then on a refresh resumes from the stored inspection. ?po=<po_number>&sku=<sku>
 * prefills steps 1–2 from GET /api/purchase-orders/{po} and /api/products/{sku}.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createInspection, getInspection, getProduct, getPurchaseOrder, runInspection } from '../services/api';
import { useApp } from '../context/AppContext';
import { useApi } from '../hooks/useAsync';
import { navigate, pathFor, setQuery } from '../lib/router';
import { Card, ConnectPrompt, ErrorState, Icon, Link, LoadingState, PageHeader, useToast } from '../components/ui';
import { useInspectionEnv } from './inspection/components';
import {
  EMPTY_MANUAL, hasReadings, manualFromForm, manualToForm, mergedChecks, runOutcome, uiVerdictOf,
} from './inspection/helpers';
import {
  EMPTY_PRODUCT, EMPTY_SHIPMENT, buildCreatePayload, formsFromInspection, productFromCatalogue, productFromPoLine,
  shipmentFromPo, validateCartons, validateProduct, validateShipment,
} from './inspection/intake';
import {
  STEPS, StepCartons, StepEvidence, StepProduct, StepReview, StepRun, StepShipment, StepVerdict, Stepper,
} from './inspection/wizardSteps';
import '../styles/inspection.css';

export default function NewInspectionPage({ route }) {
  const { hasKey } = useApp();
  const draftId = route.query.id || '';
  // Remount the wizard when the draft changes (create, or "start new") so its state always matches the URL.
  const key = draftId ? `id:${draftId}` : `new:${route.query.po || ''}:${route.query.sku || ''}:${route.query.fresh || ''}`;
  return (
    <div className="stack">
      <PageHeader
        title="New inspection"
        subtitle="Record the PO line, shipment and cartons, add photo evidence and operator counts, then run the receiving checks."
        breadcrumbs={[{ label: 'Inspections', to: 'inspections' }, { label: draftId ? `Draft ${draftId}` : 'New' }]}
        actions={draftId ? (
          <>
            <Link to={pathFor('inspections', draftId)} className="btn-theme"><Icon name="external" size={14} /> Detail</Link>
            <button type="button" className="btn-theme" onClick={() => navigate('new-inspection', { fresh: Date.now().toString(36) })}>
              <Icon name="plus" size={14} /> Start another
            </button>
          </>
        ) : null}
      />
      {!hasKey ? <Card><ConnectPrompt /></Card> : <Wizard key={key} query={route.query} draftId={draftId} />}
    </div>
  );
}

function clampStep(value, max) {
  const n = Math.round(Number(value) || 1);
  return Math.min(Math.max(1, n), max);
}

function Wizard({ query, draftId }) {
  const toast = useToast();
  const env = useInspectionEnv();
  const { refreshCounts } = useApp();

  const insp = useApi(() => getInspection(draftId), [draftId], { enabled: Boolean(draftId) });
  const inspection = draftId ? insp.data : null;

  const [shipment, setShipment] = useState(EMPTY_SHIPMENT);
  const [product, setProduct] = useState(EMPTY_PRODUCT);
  const [cartons, setCartons] = useState([]);
  const [selectedPo, setSelectedPo] = useState(null);
  const [prefillNotes, setPrefillNotes] = useState([]);
  const [errors, setErrors] = useState({ shipment: {}, product: {}, cartons: {} });
  const [touched, setTouched] = useState({});
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);

  const [manualForm, setManualForm] = useState({ ...EMPTY_MANUAL });
  const [manualErrors, setManualErrors] = useState({});
  const [scenario, setScenario] = useState('');
  const [run, setRun] = useState({ state: 'idle', result: null, outcome: null });
  const [runError, setRunError] = useState(null);
  const [runFormError, setRunFormError] = useState('');

  // Resume: fill the forms once from the stored draft.
  const hydrated = useRef(false);
  useEffect(() => {
    if (!inspection || hydrated.current) return;
    hydrated.current = true;
    const forms = formsFromInspection(inspection);
    setShipment(forms.shipment);
    setProduct(forms.product);
    setCartons(forms.cartons);
    setManualForm(manualToForm(inspection.manual_observations));
  }, [inspection]);

  // Prefill from ?po=&sku= (new drafts only).
  useEffect(() => {
    if (draftId || (!query.po && !query.sku)) return;
    let active = true;
    (async () => {
      const notes = [];
      let line = null;
      if (query.po) {
        try {
          const po = await getPurchaseOrder(query.po);
          if (!active) return;
          setSelectedPo(po);
          setShipment((current) => shipmentFromPo(po, current));
          line = query.sku ? (po.lines || []).find((l) => String(l.sku).toLowerCase() === String(query.sku).toLowerCase()) : (po.lines?.length === 1 ? po.lines[0] : null);
          if (line) setProduct(productFromPoLine(line));
          else if (query.sku) notes.push(`Purchase order ${query.po} has no line for SKU ${query.sku}.`);
        } catch (error) {
          if (!active) return;
          setShipment((current) => ({ ...current, po_number: query.po }));
          notes.push(error.status === 404 ? `Purchase order ${query.po} was not found — enter its details manually.` : `Could not load purchase order ${query.po}: ${error.message}`);
        }
      }
      if (query.sku && !line) {
        try {
          const prod = await getProduct(query.sku);
          if (!active) return;
          setProduct((current) => productFromCatalogue(prod, current));
        } catch (error) {
          if (!active) return;
          setProduct((current) => ({ ...current, sku: query.sku }));
          notes.push(error.status === 404 ? `Product ${query.sku} is not in the catalogue — enter its details manually.` : `Could not load product ${query.sku}: ${error.message}`);
        }
      }
      if (active) setPrefillNotes(notes);
    })();
    return () => { active = false; };
  }, [draftId, query.po, query.sku]);

  const locked = Boolean(draftId);
  const maxReachable = !draftId ? 3 : 7;
  const step = clampStep(query.step || (draftId ? (inspection?.record ? 6 : 4) : 1), maxReachable);
  const go = (n) => setQuery({ step: clampStep(n, maxReachable) }, { replace: false });

  // Live validation once a step has been attempted.
  const productCheck = useMemo(() => validateProduct(product), [product]);
  useEffect(() => {
    if (locked) return;
    setErrors({
      shipment: touched[1] ? validateShipment(shipment) : {},
      product: touched[2] ? productCheck.errors : {},
      cartons: touched[3] ? validateCartons(cartons) : {},
    });
  }, [shipment, productCheck, cartons, touched, locked]);

  const stepErrors = (n) => {
    if (n === 1) return validateShipment(shipment);
    if (n === 2) return productCheck.errors;
    if (n === 3) {
      const c = validateCartons(cartons);
      return Object.keys(c.rows).length || c.general ? { cartons: true } : {};
    }
    return {};
  };

  const next = async () => {
    if (step <= 3 && !locked) {
      setTouched((t) => ({ ...t, [step]: true }));
      if (Object.keys(stepErrors(step)).length) {
        toast.warning('Fix the highlighted fields to continue.');
        return;
      }
      if (step === 3) {
        // Validate everything, then create the inspection.
        for (const n of [1, 2]) {
          if (Object.keys(stepErrors(n)).length) {
            setTouched((t) => ({ ...t, [n]: true }));
            go(n);
            toast.warning(`Step ${n} has invalid fields.`);
            return;
          }
        }
        setCreating(true);
        setCreateError(null);
        try {
          const payload = buildCreatePayload(shipment, product, cartons);
          const created = await createInspection(payload.po, { shipment: payload.shipment, cartons: payload.cartons });
          toast.success(`Inspection ${created.inspection_id} created`);
          navigate('new-inspection', { id: created.inspection_id, step: 4 }, { replace: true });
        } catch (error) {
          setCreateError(error);
          toast.error(error, 'Could not create the inspection');
        } finally {
          setCreating(false);
        }
        return;
      }
    }
    go(step + 1);
  };

  const doRun = async () => {
    const { errors: mErrors, payload } = manualFromForm(manualForm);
    setManualErrors(mErrors);
    setRunFormError('');
    if (Object.keys(mErrors).length) { setRunFormError('Fix the highlighted operator counts.'); return; }
    if (!(inspection?.images?.length) && !hasReadings(payload)) {
      setRunFormError('Upload at least one photo (step 4) or enter operator counts — the inspection needs evidence to run.');
      return;
    }
    // Explicit {} clears previously stored operator counts; omitting the field would reuse them.
    const manual = payload || (inspection?.manual_observations ? {} : undefined);
    setRun({ state: 'running', result: null, outcome: null });
    setRunError(null);
    try {
      const result = await runInspection(draftId, { manual_observations: manual, scenario: env.demoMode ? scenario : undefined });
      setRun({ state: 'completed', result, outcome: runOutcome(result) });
      await insp.reload();
      refreshCounts();
      toast.success(`Run complete: ${result.verdict || 'not decided'}`);
      go(6);
    } catch (error) {
      setRun({ state: 'failed', result: null, outcome: null });
      setRunError(error);
      toast.error(error, 'Run failed');
    }
  };

  if (draftId && insp.error && !inspection) {
    return (
      <Card>
        <ErrorState error={insp.error} onRetry={insp.reload} title={`Could not load draft ${draftId}`} />
        <div className="ui-button-row insp-pad">
          <button type="button" className="btn-theme" onClick={() => navigate('new-inspection', { fresh: Date.now().toString(36) })}>Start a new inspection</button>
        </div>
      </Card>
    );
  }
  if (draftId && !inspection) return <Card><LoadingState label={`Loading draft ${draftId}…`} /></Card>;

  const checks = mergedChecks(inspection);
  const outcome = run.outcome && run.state === 'completed' ? run.outcome : runOutcome(inspection);
  const current = STEPS[step - 1];

  return (
    <div className="stack">
      <Stepper step={step} maxReachable={maxReachable} onGo={go} />
      <Card flush title={`${step}. ${current.label}`} sub={stepSubtitle(step, inspection)}>
        <div className="card-body insp-step-body">
          {step === 1 && (
            <StepShipment form={shipment} setForm={setShipment} errors={errors.shipment} locked={locked} inspectionId={draftId}
              selectedPo={selectedPo} prefillNotes={prefillNotes}
              onPickPo={(po) => { setSelectedPo(po); setShipment((c) => shipmentFromPo(po, c)); if (po.lines?.length === 1) setProduct(productFromPoLine(po.lines[0])); }} />
          )}
          {step === 2 && (
            <StepProduct form={product} setForm={setProduct} errors={errors.product} warnings={productCheck.warnings} locked={locked}
              inspectionId={draftId} selectedPo={selectedPo}
              onPickLine={(line) => setProduct(productFromPoLine(line))}
              onPickProduct={(p) => setProduct((c) => productFromCatalogue(p, c))} />
          )}
          {step === 3 && (
            <StepCartons cartons={cartons} setCartons={setCartons} errors={errors.cartons} locked={locked} inspectionId={draftId}
              expectedCartons={product.expected_cartons} />
          )}
          {step === 4 && inspection && <StepEvidence inspection={inspection} onUploaded={() => insp.reload()} />}
          {step === 5 && inspection && (
            <StepRun inspection={inspection} env={env} manualForm={manualForm} setManualForm={setManualForm} manualErrors={manualErrors}
              scenario={scenario} setScenario={setScenario} run={run} runError={runError} onRun={doRun} formError={runFormError} />
          )}
          {step === 6 && inspection && <StepVerdict inspection={inspection} checks={checks} outcome={outcome} uiVerdict={uiVerdictOf(inspection)} />}
          {step === 7 && inspection && <StepReview inspection={inspection} onCreated={() => { insp.reload(); refreshCounts(); }} />}

          {createError && step === 3 && <ErrorState error={createError} title="The inspection was not created" />}
        </div>
        <div className="insp-wizard-nav">
          <button type="button" className="btn-theme" onClick={() => go(step - 1)} disabled={step === 1}>
            <Icon name="arrowLeft" size={14} /> Back
          </button>
          <span className="hint">Step {step} of {STEPS.length}</span>
          {step < STEPS.length && (
            <button type="button" className="btn-primary" onClick={next} disabled={creating || (step === 5 && run.state === 'running')}>
              {creating ? <span className="spinner" aria-hidden="true" /> : null}
              {step === 3 && !locked ? (creating ? 'Creating inspection…' : 'Create inspection & continue') : step === 5 && !inspection?.record ? 'Skip to verdict' : 'Next'}
              {!creating && <Icon name="arrowRight" size={14} />}
            </button>
          )}
          {step === STEPS.length && (
            <Link to={pathFor('inspections', draftId)} className="btn-primary">Finish <Icon name="arrowRight" size={14} /></Link>
          )}
        </div>
      </Card>
    </div>
  );
}

function stepSubtitle(step, inspection) {
  switch (step) {
    case 1: return 'Which delivery is this? Pick an existing purchase order to prefill, or type the details.';
    case 2: return 'The PO line being received — every check compares against these expected values.';
    case 3: return 'Cartons as they arrived at the dock (optional). Leaving this step creates the inspection.';
    case 4: return `Photo evidence for ${inspection?.inspection_id || 'the inspection'}.`;
    case 5: return 'Add your own counts if you have them, then run the receiving checks.';
    case 6: return 'Overall verdict and every check with its evidence.';
    case 7: return 'Hand the result to a person when needed.';
    default: return '';
  }
}
