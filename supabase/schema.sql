-- Ejecuta esto en Supabase: Panel del proyecto -> SQL Editor -> New query -> pega y "Run"
-- Este script se puede volver a ejecutar entero cuando quieras (por ejemplo, tras
-- actualizar el panel) sin que dé error por elementos que ya existan.

-- ================================================================
-- Este script se puede volver a ejecutar entero cuando quieras (por
-- ejemplo, tras actualizar el panel) sin que dé error por elementos
-- que ya existan. El bloque final asciende a administrador la cuenta
-- c.manager@leotec.com — cámbiala ahí abajo si usas otro email.
-- ================================================================

create table if not exists public.facturas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  centro text not null check (centro in ('coslada','hospitalet')),
  anio int not null,
  mes int not null check (mes between 1 and 12),
  expediciones int not null default 0,
  bultos int not null default 0,
  peso numeric not null default 0,
  portes numeric not null default 0,
  combustible numeric not null default 0,
  total numeric not null default 0,
  detalle jsonb, -- desglose completo (destinatarios, centros Decathlon, rango de peso...) para regenerar el informe/email
  email_borrador text, -- texto del borrador de email generado
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, centro, anio, mes)
);

alter table public.facturas enable row level security;

-- Mantiene updated_at al día
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_facturas_updated_at on public.facturas;
create trigger trg_facturas_updated_at
  before update on public.facturas
  for each row execute function public.set_updated_at();

-- ================================================================
-- Contactos guardados (destinatarios/remitentes frecuentes) para la
-- pestaña "Crear envío".
-- ================================================================

create table if not exists public.contactos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  nombre text not null,
  nif text,
  telefono text,
  email text,
  calle text not null,
  poblacion text not null,
  cp text not null,
  pais text not null default 'ES',
  notas text,
  created_at timestamptz not null default now()
);

alter table public.contactos enable row level security;

-- ================================================================
-- PERFILES DE USUARIO: roles, aprobación de acceso y permisos por
-- pestaña. Un administrador da de alta las direcciones autorizadas
-- (desde la pestaña "Administración" del panel) y decide a qué
-- secciones puede entrar cada persona.
-- ================================================================

create table if not exists public.perfiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  rol text not null default 'pendiente' check (rol in ('admin','usuario','pendiente')),
  activo boolean not null default false,
  -- permisos: objeto {"informe":true,"decathlon":true,"evolucion":true,"historial":true,"tarifas":true,"envios":true}
  -- Los administradores (rol = 'admin') siempre ven todo, independientemente de este campo.
  permisos jsonb not null default '{"informe":true,"decathlon":true,"evolucion":true,"historial":true,"tarifas":true,"envios":true}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.perfiles enable row level security;

-- Funciones auxiliares (security definer: evitan la recursión de RLS
-- al consultar la propia tabla perfiles desde sus políticas).
create or replace function public.es_admin()
returns boolean language sql security definer stable as $$
  select exists(select 1 from public.perfiles where user_id = auth.uid() and rol = 'admin' and activo = true);
$$;

create or replace function public.es_activo()
returns boolean language sql security definer stable as $$
  select exists(select 1 from public.perfiles where user_id = auth.uid() and activo = true);
$$;

-- Ruta del PDF original en Supabase Storage (bucket facturas-pdf), si se ha subido.
alter table public.facturas add column if not exists pdf_path text;

-- ================================================================
-- Almacén de los PDF originales de las facturas (bucket privado).
-- ================================================================

insert into storage.buckets (id, name, public)
values ('facturas-pdf', 'facturas-pdf', false)
on conflict (id) do nothing;

alter table storage.objects enable row level security;

drop policy if exists "facturas_pdf_select" on storage.objects;
create policy "facturas_pdf_select" on storage.objects
  for select using (bucket_id = 'facturas-pdf' and public.es_activo());

drop policy if exists "facturas_pdf_insert" on storage.objects;
create policy "facturas_pdf_insert" on storage.objects
  for insert with check (bucket_id = 'facturas-pdf' and public.es_activo());

drop policy if exists "facturas_pdf_update" on storage.objects;
create policy "facturas_pdf_update" on storage.objects
  for update using (bucket_id = 'facturas-pdf' and public.es_activo());

drop policy if exists "facturas_pdf_delete" on storage.objects;
create policy "facturas_pdf_delete" on storage.objects
  for delete using (bucket_id = 'facturas-pdf' and public.es_activo());

-- Crea automáticamente un perfil (pendiente/inactivo) para cualquier
-- usuario nuevo que se cree en auth.users (incluidos los invitados
-- por el administrador; su invitación se activa aparte, ver función
-- de invitación en netlify/functions/admin-invite.js).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.perfiles (user_id, email, rol, activo)
  values (new.id, new.email, 'pendiente', false)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Políticas de perfiles: cada uno ve/edita el suyo; el admin ve/edita todos.
drop policy if exists "select_perfiles" on public.perfiles;
create policy "select_perfiles" on public.perfiles
  for select using (auth.uid() = user_id or public.es_admin());

drop policy if exists "update_perfiles" on public.perfiles;
create policy "update_perfiles" on public.perfiles
  for update using (public.es_admin());

drop policy if exists "insert_perfiles" on public.perfiles;
create policy "insert_perfiles" on public.perfiles
  for insert with check (public.es_admin());

-- ================================================================
-- Datos compartidos: facturas y contactos son un panel de empresa,
-- no espacios privados por persona — cualquier usuario activo y
-- autorizado ve y gestiona los mismos datos (el que los creó queda
-- guardado en user_id a efectos informativos, no como propietario
-- exclusivo).
-- ================================================================

drop policy if exists "select_own_facturas" on public.facturas;
drop policy if exists "select_shared_facturas" on public.facturas;
create policy "select_shared_facturas" on public.facturas
  for select using (public.es_activo());

drop policy if exists "insert_own_facturas" on public.facturas;
drop policy if exists "insert_shared_facturas" on public.facturas;
create policy "insert_shared_facturas" on public.facturas
  for insert with check (public.es_activo());

drop policy if exists "update_own_facturas" on public.facturas;
drop policy if exists "update_shared_facturas" on public.facturas;
create policy "update_shared_facturas" on public.facturas
  for update using (public.es_activo());

drop policy if exists "delete_own_facturas" on public.facturas;
drop policy if exists "delete_shared_facturas" on public.facturas;
create policy "delete_shared_facturas" on public.facturas
  for delete using (public.es_activo());

drop policy if exists "select_own_contactos" on public.contactos;
drop policy if exists "select_shared_contactos" on public.contactos;
create policy "select_shared_contactos" on public.contactos
  for select using (public.es_activo());

drop policy if exists "insert_own_contactos" on public.contactos;
drop policy if exists "insert_shared_contactos" on public.contactos;
create policy "insert_shared_contactos" on public.contactos
  for insert with check (public.es_activo());

drop policy if exists "update_own_contactos" on public.contactos;
drop policy if exists "update_shared_contactos" on public.contactos;
create policy "update_shared_contactos" on public.contactos
  for update using (public.es_activo());

drop policy if exists "delete_own_contactos" on public.contactos;
drop policy if exists "delete_shared_contactos" on public.contactos;
create policy "delete_shared_contactos" on public.contactos
  for delete using (public.es_activo());

-- ================================================================
-- BOOTSTRAP DEL ADMINISTRADOR
-- Crea perfil "pendiente" para cualquier usuario ya existente que
-- todavía no tenga uno, y a continuación asciende a administrador
-- activo tu cuenta actual (c.manager@leotec.com). Si quieres que el
-- administrador sea otra dirección, cámbiala aquí antes de ejecutar.
-- ================================================================

insert into public.perfiles (user_id, email, rol, activo)
select id, email, 'pendiente', false from auth.users
on conflict (user_id) do nothing;

update public.perfiles
set rol = 'admin', activo = true
where email = 'c.manager@leotec.com';
