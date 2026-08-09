-- Ejecuta esto en Supabase: Panel del proyecto -> SQL Editor -> New query -> pega y "Run"

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

-- Cada usuario solo ve y edita sus propias facturas
create policy "select_own_facturas" on public.facturas
  for select using (auth.uid() = user_id);

create policy "insert_own_facturas" on public.facturas
  for insert with check (auth.uid() = user_id);

create policy "update_own_facturas" on public.facturas
  for update using (auth.uid() = user_id);

create policy "delete_own_facturas" on public.facturas
  for delete using (auth.uid() = user_id);

-- Mantiene updated_at al día
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_facturas_updated_at
  before update on public.facturas
  for each row execute function public.set_updated_at();
