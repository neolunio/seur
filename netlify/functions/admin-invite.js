// netlify/functions/admin-invite.js
//
// Permite que un administrador invite una nueva dirección de correo al
// panel. Usa la "service_role key" de Supabase (permisos de
// administrador sobre Auth), que por eso vive SOLO aquí, en el
// servidor, y nunca se envía al navegador. No depende de ningún
// paquete externo: habla directamente con la API REST de Supabase.
//
// Antes de cada invitación comprueba, con el token de sesión de quien
// hace la petición, que esa persona es realmente un administrador
// activo — si no, la rechaza. Así nadie puede invitarse a sí mismo
// llamando a este endpoint directamente.
//
// Variables de entorno necesarias (Netlify -> Site settings -> Environment variables):
//   SUPABASE_URL               -> la misma URL del proyecto que usa el panel
//   SUPABASE_SERVICE_ROLE_KEY  -> Supabase -> Project Settings -> API ->
//                                  "Legacy anon, service_role API keys" -> service_role (Reveal)
//                                  ¡Es un secreto! No la pongas nunca en el código ni en GitHub.

const DEFAULT_PERMISOS = {
  informe: true, decathlon: true, evolucion: true, historial: true, tarifas: true, envios: true,
};

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }
  try {
    const { email, accessToken } = await req.json();
    if (!email || !accessToken) {
      return new Response(JSON.stringify({ error: 'Faltan email o accessToken' }), { status: 400 });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return new Response(JSON.stringify({ error: 'Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en las variables de entorno de Netlify' }), { status: 500 });
    }

    // 1. Verifica quién llama, a partir de su propio token de sesión
    const whoResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${accessToken}` },
    });
    if (!whoResp.ok) {
      return new Response(JSON.stringify({ error: 'Sesión no válida' }), { status: 401 });
    }
    const caller = await whoResp.json();

    // 2. Comprueba que quien llama es administrador activo (consulta directa, salta RLS con la service key)
    const perfilResp = await fetch(
      `${SUPABASE_URL}/rest/v1/perfiles?user_id=eq.${caller.id}&select=rol,activo`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    const perfiles = await perfilResp.json();
    const perfil = Array.isArray(perfiles) ? perfiles[0] : null;
    if (!perfil || perfil.rol !== 'admin' || !perfil.activo) {
      return new Response(JSON.stringify({ error: 'Solo un administrador puede invitar usuarios' }), { status: 403 });
    }

    // 3. Invita al nuevo email (Supabase le manda un correo para fijar su contraseña)
    const inviteResp = await fetch(`${SUPABASE_URL}/auth/v1/invite`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const invited = await inviteResp.json();
    if (!inviteResp.ok) {
      return new Response(JSON.stringify({ error: `No se pudo invitar: ${invited.msg || invited.message || inviteResp.status}` }), { status: 400 });
    }

    // 4. Deja su perfil ya activo con permisos por defecto (el admin los podrá ajustar después)
    const upsertResp = await fetch(`${SUPABASE_URL}/rest/v1/perfiles`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ user_id: invited.id, email, rol: 'usuario', activo: true, permisos: DEFAULT_PERMISOS }),
    });
    if (!upsertResp.ok) {
      const t = await upsertResp.text();
      return new Response(JSON.stringify({ error: `Usuario invitado pero no se pudo activar el perfil: ${t}` }), { status: 500 });
    }

    return new Response(JSON.stringify({ ok: true, email }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = { path: '/api/admin-invite' };
