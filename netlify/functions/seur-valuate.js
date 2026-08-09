// netlify/functions/seur-valuate.js
//
// Proxy seguro hacia la API pública de SEUR (PIC). Recibe desde el panel
// una lista de envíos (origen, destino, peso...) y devuelve el precio
// contratado REAL para cada uno, consultando el servicio oficial
// "Cálculo de tarifas de envío" (POST /pic/v1/valuate).
//
// Las credenciales de SEUR NUNCA viajan al navegador: viven como
// variables de entorno en Netlify y esta función corre en el servidor.
//
// Variables de entorno necesarias (Netlify -> Site settings -> Environment variables):
//   SEUR_API_BASE    -> https://servicios.api.seur.io        (producción)
//                        https://servicios.apipre.seur.io    (preproducción / pruebas)
//   SEUR_CLIENT_ID
//   SEUR_CLIENT_SECRET
//   SEUR_USERNAME
//   SEUR_PASSWORD
//
// El resto de datos (CCC, código de servicio/producto) los manda el
// panel en cada petición porque cambian según el centro (Coslada u
// Hospitalet).

const MAX_BATCH = 20; // nº máximo de envíos por llamada a SEUR (prudencial)

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

async function valuateBatch(token, shipments) {
  const base = process.env.SEUR_API_BASE || 'https://servicios.api.seur.io';
  const payload = shipments.map(s => ({
    originCountryCode: 'ES',
    originPostalCode: String(s.originPostalCode || ''),
    destinationCountryCode: 'ES',
    destinationPostalCode: String(s.destinationPostalCode || ''),
    packsNumber: s.packsNumber || 1,
    weight: s.weight,
    serviceCode: s.serviceCode || 1,
    productCode: s.productCode || 2,
    ccc: s.ccc,
  }));
  const resp = await fetch(`${base}/pic/v1/valuate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Error consultando tarifas SEUR (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  return data.data || [];
}

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }
  try {
    const { shipments } = await req.json();
    if (!Array.isArray(shipments) || shipments.length === 0) {
      return new Response(JSON.stringify({ error: 'Falta la lista de envíos (shipments)' }), { status: 400 });
    }

    const token = await getToken();
    const results = [];
    for (let i = 0; i < shipments.length; i += MAX_BATCH) {
      const chunk = shipments.slice(i, i + MAX_BATCH);
      const chunkResults = await valuateBatch(token, chunk);
      results.push(...chunkResults);
    }

    return new Response(JSON.stringify({ data: results }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = { path: '/api/seur-valuate' };
