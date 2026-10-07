const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

// Each key maps server-side to one organization + operator. Set it per browser:
// localStorage.setItem('receivingApiKey', '<key>'), or VITE_RECEIVING_API_KEY for local dev only.
function apiKey() {
  try {
    return localStorage.getItem('receivingApiKey') || import.meta.env.VITE_RECEIVING_API_KEY || '';
  } catch {
    return import.meta.env.VITE_RECEIVING_API_KEY || '';
  }
}

function authHeaders(extra = {}) {
  return { 'X-API-Key': apiKey(), ...extra };
}

export async function healthCheck() {
  const response = await fetch(`${API_BASE_URL}/api/health`);
  return response.json();
}

export async function createInspection(poData) {
  const response = await fetch(`${API_BASE_URL}/api/inspections`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ po: poData }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || 'Failed to create inspection');
  }

  return response.json();
}

export async function getInspection(inspectionId) {
  const response = await fetch(`${API_BASE_URL}/api/inspections/${inspectionId}`, { headers: authHeaders() });
  if (!response.ok) {
    throw new Error('Inspection not found');
  }
  return response.json();
}

export async function uploadInspectionImages(inspectionId, files, view = 'receiving_photo') {
  const formData = new FormData();
  files.forEach((file) => formData.append('files', file));
  formData.append('image_type', view);

  const response = await fetch(`${API_BASE_URL}/api/inspections/${inspectionId}/images`, {
    method: 'POST',
    headers: authHeaders(),
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || 'Failed to upload images');
  }

  return response.json();
}

export async function analyzeInspection(inspectionId, scenario = '') {
  const url = new URL(`${API_BASE_URL}/api/inspections/${inspectionId}/analyze`);
  if (scenario) url.searchParams.set('scenario', scenario);

  const response = await fetch(url, { method: 'POST', headers: authHeaders() });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || 'Analysis failed');
  }

  return response.json();
}

export async function overrideInspection(inspectionId, decision, reason) {
  const response = await fetch(`${API_BASE_URL}/api/inspections/${inspectionId}/override`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ decision, reason }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || 'Override failed');
  }

  return response.json();
}

// <img src> cannot send headers, so fetch the image with the key and hand back an object URL.
export async function fetchInspectionImageUrl(inspectionId, imageId) {
  const response = await fetch(`${API_BASE_URL}/api/inspections/${inspectionId}/images/${imageId}`, { headers: authHeaders() });
  if (!response.ok) throw new Error('Image not available');
  return URL.createObjectURL(await response.blob());
}
