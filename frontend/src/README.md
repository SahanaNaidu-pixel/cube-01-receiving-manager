# Frontend guide (for page builders)

React 18 + Vite. No router or UI library — everything below is in this folder. Real data only: every number,
list and status comes from the API (`docs/API.md`, `docs/A2A.md`). No mock data, no `setTimeout` fakery, no dead buttons.

## Folder structure

```
src/
  App.jsx                 providers → landing (#/) or AppShell (#/app/…)
  routes.js               ROUTES (page key → list/detail component) + NAV_SECTIONS (sidebar)  ← register pages here
  context/AppContext.jsx  useApp(): api key, connection, principal/systemInfo, /ready, badge counts, theme
  services/api.js         one function per endpoint; ApiError
  lib/router.js           useRoute, navigate, buildHref, pathFor, setQuery
  lib/format.js           formatters, verdict mapping, date ranges, listParamsFromQuery
  hooks/useAsync.js       useAsync / useApi data hooks
  hooks/useShortcuts.js   global keyboard shortcuts (documented on Help)
  components/AppShell.jsx sidebar, topbar, key panel, mobile drawer, page error boundary
  components/ui/          the component kit (import from 'components/ui')
  components/Shared.jsx   Icon (+ ICON_NAMES), legacy Card/ChecksTable/Gallery/EvidenceImage/VerifyIntegrity…
  components/*View.jsx    the first UI (Scanner/Ledger/Benchmark/Rules) — not mounted; reuse/absorb, then delete
  pages/                  one file per page
  styles.css              tokens at the top; kit styles at the bottom (prefix .ui-*)
```

## Adding / replacing a page

1. Edit the file in `src/pages/` (placeholders already exist and are registered in `routes.js`). Remove the
   `<UnderConstruction>` usage.
2. A page receives `{ route }` (`route.params` = decoded path segments, `route.query` = hash query). It is
   re-mounted when the path changes, not when the query changes.
3. Skeleton:

```jsx
import { listIssues } from '../services/api';
import { useApi } from '../hooks/useAsync';
import { navigate, pathFor, setQuery } from '../lib/router';
import { listParamsFromQuery, formatDateTime } from '../lib/format';
import { Card, ConnectPrompt, DataTable, FilterBar, PageHeader, Pagination, SeverityBadge, StatusBadge } from '../components/ui';

export default function ExceptionsPage({ route }) {
  const params = listParamsFromQuery(route.query, ['q', 'status', 'severity', 'issue_type', 'po', 'sku']);
  const { data, error, loading, reload, notConnected } = useApi(() => listIssues(params), [JSON.stringify(params)]);
  if (notConnected) return <Card><ConnectPrompt /></Card>;
  return (
    <div className="stack">
      <PageHeader title="Exceptions" subtitle="…" />
      <FilterBar
        search={{ value: route.query.q, onChange: (q) => setQuery({ q, page: 1 }) }}
        selects={[{ key: 'status', label: 'Status', value: route.query.status,
          options: [{ value: 'open', label: 'Open' }], onChange: (status) => setQuery({ status, page: 1 }) }]}
        dateRange={{ value: route.query, onChange: (patch) => setQuery({ ...patch, page: 1 }) }}
        resultCount={data?.total}
      />
      <Card flush>
        <DataTable rows={data?.items} rowKey="issue_id" loading={loading} error={error} onRetry={reload}
          onRowClick={(row) => navigate(pathFor('issues', row.issue_id))}
          columns={[{ key: 'issue_id', header: 'Issue' }, { key: 'severity', header: 'Severity', render: (r) => <SeverityBadge severity={r.severity} /> }]} />
        <Pagination page={data?.page} pageSize={data?.page_size} total={data?.total}
          onPageChange={(page) => setQuery({ page })} onPageSizeChange={(page_size) => setQuery({ page_size, page: 1 })} />
      </Card>
    </div>
  );
}
```

4. Mutations: use `AsyncButton` (shows loading/success/failed + toast) or `useToast()`; reload the data after
   success; call `useApp().refreshCounts()` when open reviews/issues change (sidebar badges).
5. New page key? Add it to `ROUTES` and (if it belongs in the sidebar) `NAV_SECTIONS` in `routes.js`.

Dashboard deep links already used (keep these filters working on the list pages):
`inspections?verdict=PASS|FAIL|UNCERTAIN|NOT_ANALYZED`, `inspections?date_from=&date_to=`, `?range=today|7d|30d`,
`reviews?status=open,evidence_requested`, `exceptions?status=open`, `exceptions?issue_type=<REASON_CODE>`.

## Routing (`lib/router.js`)

| Helper | Use |
|---|---|
| `useRoute()` | `{area, page, params, id, query, path}`; re-renders on hash change |
| `navigate(path, query?, {replace?})` | `navigate('inspections', {verdict: 'FAIL'})`, `navigate('/')` |
| `pathFor(page, ...ids)` | encoded detail path: `pathFor('cartons', inspectionId, cartonId)` |
| `buildHref(path, query?)` | `'#/app/…?…'` for `<a href>` (prefer `<Link to query>`) |
| `setQuery(patch)` | merge into current query (null/'' removes); replaces history entry by default |

Detail routes: `inspections/<id>`, `reviews/<id>`, `issues/<id>` (→ exceptions entry), `evidence/<id>`,
`purchase-orders/<po>`, `products/<sku>`, `shipments/<id>`, `cartons/<inspectionId>/<cartonId>`,
`agent-activity/<requestId>`. Aliases: `scanner→new-inspection`, `ledger→inspections`, `benchmark|rules→help`,
`review-queue→reviews`, `issues→exceptions`, `health→system-health`.

## API client (`services/api.js`)

- Every function returns parsed JSON. List functions take a params object (empty values dropped):
  `listInspections, listIssues, listReviews, listEvidence, listProducts, listPurchaseOrders, listShipments,
  listCartons, listAudit, listAgentActivity` → `{items, count, total, page, page_size}`.
- Errors throw `ApiError` with `.status` (0 = backend unreachable), `.code`, `.requestId`, `.details`, `.message`
  (backend `detail`). Show them with `<ErrorState error={err}/>` or `toast.error(err, 'Title')`.
- Inspections: `createInspection(po, {shipment, cartons})`, `getInspection`, `uploadInspectionImages(id, files, view)`,
  `runInspection(id, {manual_observations, scenario})`, `requestInspectionReview(id, reason, assignedTo)`,
  `overrideInspection(id, decision, reason)`, `addInspectionNote`, `handoffInspection(id, targetAgent)`,
  `verifyInspection`, `getInspectionAudit`, `exportInspection(id, fmt)` / `downloadInspectionExport(id, fmt)`,
  `fetchInspectionImageUrl(id, imageId)` (revoke the object URL), `fetchInspectionImageBlob`.
- Issues: `getIssue, issueAction(id, action, {note, assigned_to}), addIssueNote, linkIssueEvidence`.
- Reviews: `getReview, decideReview(id, decision, note), requestReviewEvidence, addReviewNote, assignReview`.
- Catalogue: `getEvidence, createProduct, getProduct, updateProduct, createPurchaseOrder, getPurchaseOrder,
  importCatalogueFile(file), importSampleCatalogue(), getShipment, getCarton(inspectionId, cartonId)`.
- Other: `getDashboard({range, date_from, date_to})`, `getSystemInfo, getHealth, getReady, probeBackend()`.
- A2A: `getAgentCapabilities, getAgentCard, buildA2AEnvelope(operation, payload, opts), sendAgentMessage(envelope)`
  (protocol failures resolve with `status: 'failed'`), `getAgentActivity(requestId)`, `fileToBase64(file)`.
- `saveBlob(blob, filename)` triggers a download. Base URL: `VITE_API_BASE_URL` (dev default localhost:8000,
  production default same origin). Never hardcode hosts.

## Data hooks

`useApi(fn, deps, {enabled})` → `{data, error, loading, reload, setData, notConnected}`; waits for an API key,
re-fetches after reconnect, keeps previous data while reloading. `reload({throwOnError: true})` for AsyncButton.
`useAsync` is the same without the key gate.

## Component kit (`components/ui`, each file has a usage comment)

| Component | Key props |
|---|---|
| `PageHeader` | `title, subtitle, actions, breadcrumbs=[{label,to}], icon` |
| `Card` | `title, sub, actions, flush` |
| `StatCard` | `label, value, note, tone, icon, to, query, onClick, loading` |
| `DataTable` | `columns=[{key, header, render, sortable, sortKey, align, mono}], rows, rowKey, onRowClick, sort, onSortChange, loading, error, onRetry, empty` |
| `Pagination` | `page, pageSize, total, onPageChange, onPageSizeChange` |
| `FilterBar` / `DateRangePicker` | `search, selects, dateRange, onReset, resultCount` |
| `VerdictBadge` / `SeverityBadge` / `StatusBadge` | `verdict` (any stored value) / `severity` / `status, tone` |
| `Modal` / `ConfirmDialog` | `title, onClose, footer, wide` / `onConfirm (promise), onCancel, tone, successToast` |
| `useToast()` | `success(msg), error(err, title), info, warning, show({...})` |
| `AsyncButton` | `onClick (promise), label, loadingLabel, successLabel, failedLabel, variant, icon, successToast, errorToast` |
| `EmptyState` / `ErrorState` / `LoadingState` / `Skeleton` / `ConnectPrompt` | states |
| `KeyValueGrid` | `items=[{label, value, mono, span}], columns` |
| `Tabs` | `tabs=[{key,label,count}], active, onChange` (keep the tab in `?tab=`) |
| `JsonViewer` | `data, title, defaultDepth` |
| `FileDropzone` (+ `createFileItems`, `updateFileItem`) | `items, onChange, accept, maxSizeMb, maxFiles, renderExtra` |
| `Timeline` (+ `auditEventToItem`) | `items=[{id,title,description,meta,time,tone,to}]` |
| `VerdictChart` | `days=[{date,pass,fail,uncertain,not_analyzed}], onSelect(date, verdict)` |
| `Link` | `to, query` — real `<a href="#/…">` |
| `Icon` | `name` (see `ICON_NAMES`), `size` |

Formatters (`lib/format.js`): `formatDateTime, formatDate, formatRelative, formatBytes, formatNumber,
formatPercent, formatLatency, humanize, truncate, toUiVerdict (PASS/EXCEPTION→FAIL/UNCERTAIN|PENDING_REVIEW→UNCERTAIN/
null→NOT_ANALYZED), verdictLabel, verdictOf(inspection), RANGE_OPTIONS, rangeToDates, listParamsFromQuery`.

Styling: reuse existing classes (`card`, `stack`, `dashboard-grid`, `btn-primary`, `btn-theme`, `detail-btn`,
`filter-input`, `filter-select`, `field`, `field-label`, `form-grid`, `hint`, `mono`, `chip`) and CSS variables;
add new rules at the end of `styles.css` with a `.ui-` or page prefix. Check both themes and widths ≤ 640px.
