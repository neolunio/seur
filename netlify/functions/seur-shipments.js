// netlify/functions/seur-shipments.js
//
// Proxy seguro hacia la API de SEUR (PIC) para crear envíos, solicitar
// recogidas y generar etiquetas. Usa las mismas variables de entorno
// que seur-valuate.js (SEUR_API_BASE, SEUR_CLIENT_ID, SEUR_CLIENT_SECRET,
// SEUR_USERNAME, SEUR_PASSWORD).
//
// ⚠️ Esto ejecuta acciones REALES contra SEUR (crea expediciones/recogidas
// de verdad si SEUR_API_BASE apunta a producción). Prueba primero contra
// el entorno de preproducción (https://servicios.apipre.seur.io).

async function getToken() {
  const base = process.env.SEUR_API_BASE || 'https://servicios.api.seur.io';
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: process.env.SEUR_CLIENT_ID || '',
    client_secret: process.env.SEUR_CLIENT_SECRET || '',
    username: process.env.SEUR_USERNAME || '',
    password: process.env.SEUR_PASSWORD || '',
  });
  const resp = await fetch(`${base}/pic_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`No se pudo obtener el token de SEUR (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  return data.access_token;
}

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }
  try {
    const { action, payload } = await req.json();
    const base = process.env.SEUR_API_BASE || 'https://servicios.api.seur.io';
    const token = await getToken();

    let url, method = 'POST', body;
    if (action === 'create_shipment') {
      url = `${base}/pic/v1/shipments`;
      body = JSON.stringify(payload);
    } else if (action === 'create_collection') {
      url = `${base}/pic/v1/collections`;
      body = JSON.stringify(payload);
    } else if (action === 'cancel_shipment') {
      url = `${base}/pic/v1/shipments/cancel`;
      body = JSON.stringify(payload);
    } else if (action === 'cancel_collection') {
      url = `${base}/pic/v1/collections/cancel`;
      body = JSON.stringify(payload);
    } else if (action === 'get_label') {
      const qs = new URLSearchParams(payload).toString();
      url = `${base}/pic/v1/labels?${qs}`;
      method = 'GET';
      body = undefined;
    } else {
      return new Response(JSON.stringify({ error: `Acción no soportada: ${action}` }), { status: 400 });
    }

    const resp = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body,
    });
    const text = await resp.text();
    if (!resp.ok) {
      return new Response(JSON.stringify({ error: `Error de SEUR (${resp.status}): ${text}` }), { status: resp.status });
    }
    return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = { path: '/api/seur-shipments' };
