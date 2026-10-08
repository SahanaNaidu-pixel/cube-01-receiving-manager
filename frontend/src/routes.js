/*
 * Route table + sidebar navigation. The single place to register a page.
 *
 * ROUTES[pageKey] = {
 *   title,            topbar title
 *   list,             component for #/app/<pageKey>
 *   detail?,          component for #/app/<pageKey>/<param>[/<param>]
 *   detailParams?,    number of path params the detail route takes (default 1; cartons = 2)
 *   detailTitle?,     topbar title on detail routes
 * }
 * Every page component receives { route } (see lib/router.js → useRoute()).
 *
 * NAV_SECTIONS drives the sidebar; `badge` names a key of AppContext.counts (shown when > 0).
 */
import { lazy } from 'react';
import NotFoundPage from './pages/NotFoundPage';

// Pages load on demand (one chunk each) so the initial bundle stays small.
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const InspectionsPage = lazy(() => import('./pages/InspectionsPage'));
const InspectionDetailPage = lazy(() => import('./pages/InspectionDetailPage'));
const NewInspectionPage = lazy(() => import('./pages/NewInspectionPage'));
const ReviewQueuePage = lazy(() => import('./pages/ReviewQueuePage'));
const ReviewDetailPage = lazy(() => import('./pages/ReviewDetailPage'));
const ExceptionsPage = lazy(() => import('./pages/ExceptionsPage'));
const IssueDetailPage = lazy(() => import('./pages/IssueDetailPage'));
const PurchaseOrdersPage = lazy(() => import('./pages/PurchaseOrdersPage'));
const PurchaseOrderDetailPage = lazy(() => import('./pages/PurchaseOrderDetailPage'));
const ShipmentsPage = lazy(() => import('./pages/ShipmentsPage'));
const ShipmentDetailPage = lazy(() => import('./pages/ShipmentDetailPage'));
const ProductsPage = lazy(() => import('./pages/ProductsPage'));
const ProductDetailPage = lazy(() => import('./pages/ProductDetailPage'));
const CartonsPage = lazy(() => import('./pages/CartonsPage'));
const CartonDetailPage = lazy(() => import('./pages/CartonDetailPage'));
const EvidencePage = lazy(() => import('./pages/EvidencePage'));
const EvidenceDetailPage = lazy(() => import('./pages/EvidenceDetailPage'));
const AuditPage = lazy(() => import('./pages/AuditPage'));
const AgentActivityPage = lazy(() => import('./pages/AgentActivityPage'));
const AgentActivityDetailPage = lazy(() => import('./pages/AgentActivityDetailPage'));
const A2APage = lazy(() => import('./pages/A2APage'));
const SystemHealthPage = lazy(() => import('./pages/SystemHealthPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const HelpPage = lazy(() => import('./pages/HelpPage'));

export const ROUTES = {
  dashboard: { title: 'Dashboard', list: DashboardPage },
  inspections: { title: 'Inspections', list: InspectionsPage, detail: InspectionDetailPage, detailTitle: 'Inspection' },
  'new-inspection': { title: 'New Inspection', list: NewInspectionPage },
  reviews: { title: 'Review Queue', list: ReviewQueuePage, detail: ReviewDetailPage, detailTitle: 'Review Task' },
  exceptions: { title: 'Exceptions', list: ExceptionsPage, detail: IssueDetailPage, detailTitle: 'Issue' },
  'purchase-orders': { title: 'Purchase Orders', list: PurchaseOrdersPage, detail: PurchaseOrderDetailPage, detailTitle: 'Purchase Order' },
  shipments: { title: 'Shipments', list: ShipmentsPage, detail: ShipmentDetailPage, detailTitle: 'Shipment' },
  products: { title: 'Products', list: ProductsPage, detail: ProductDetailPage, detailTitle: 'Product' },
  cartons: { title: 'Cartons', list: CartonsPage, detail: CartonDetailPage, detailParams: 2, detailTitle: 'Carton' },
  evidence: { title: 'Evidence', list: EvidencePage, detail: EvidenceDetailPage, detailTitle: 'Evidence File' },
  audit: { title: 'Audit Trail', list: AuditPage },
  'agent-activity': { title: 'Agent Activity', list: AgentActivityPage, detail: AgentActivityDetailPage, detailTitle: 'Agent Message' },
  a2a: { title: 'A2A Integration', list: A2APage },
  'system-health': { title: 'System Health', list: SystemHealthPage },
  settings: { title: 'Settings', list: SettingsPage },
  help: { title: 'Help', list: HelpPage },
};

/** The detail route `#/app/issues/<id>` resolves to the exceptions entry (see router ALIASES). */
export function resolveRoute(route) {
  const entry = ROUTES[route.page];
  if (!entry) return { component: NotFoundPage, title: 'Not found', navKey: null };
  if (route.params.length === 0) return { component: entry.list, title: entry.title, navKey: route.page };
  const expected = entry.detailParams || 1;
  if (!entry.detail || route.params.length !== expected) return { component: NotFoundPage, title: 'Not found', navKey: route.page };
  return { component: entry.detail, title: entry.detailTitle || entry.title, navKey: route.page };
}

export const NAV_SECTIONS = [
  {
    label: 'Overview',
    items: [{ key: 'dashboard', label: 'Dashboard', icon: 'grid' }],
  },
  {
    label: 'Receiving',
    items: [
      { key: 'inspections', label: 'Inspections', icon: 'list' },
      { key: 'new-inspection', label: 'New Inspection', icon: 'scan' },
      { key: 'reviews', label: 'Review Queue', icon: 'users', badge: 'open_reviews', badgeTitle: 'Open review tasks' },
      { key: 'exceptions', label: 'Exceptions', icon: 'alert', badge: 'open_issues', badgeTitle: 'Open issues' },
    ],
  },
  {
    label: 'Orders & Stock',
    items: [
      { key: 'purchase-orders', label: 'Purchase Orders', icon: 'file' },
      { key: 'shipments', label: 'Shipments', icon: 'truck' },
      { key: 'products', label: 'Products', icon: 'tag' },
      { key: 'cartons', label: 'Cartons', icon: 'box' },
    ],
  },
  {
    label: 'Records',
    items: [
      { key: 'evidence', label: 'Evidence', icon: 'image' },
      { key: 'audit', label: 'Audit Trail', icon: 'history' },
    ],
  },
  {
    label: 'Integration',
    items: [
      { key: 'agent-activity', label: 'Agent Activity', icon: 'activity' },
      { key: 'a2a', label: 'A2A Integration', icon: 'link' },
    ],
  },
  {
    label: 'System',
    items: [
      { key: 'system-health', label: 'System Health', icon: 'server' },
      { key: 'settings', label: 'Settings', icon: 'settings' },
      { key: 'help', label: 'Help', icon: 'help' },
    ],
  },
];
