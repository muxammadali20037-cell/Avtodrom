create extension if not exists pgcrypto;

create table if not exists public.admin_media (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  title text not null,
  media_type text not null check (media_type in ('image','video')),
  storage_path text not null unique,
  public_url text not null,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists admin_media_type_active_idx
  on public.admin_media(media_type, is_active, sort_order, created_at desc);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'customer-media',
  'customer-media',
  true,
  524288000,
  array[
    'image/jpeg','image/png','image/webp','image/gif',
    'video/mp4','video/webm','video/quicktime'
  ]
)
on conflict (id) do update
set public=true,
    file_size_limit=524288000,
    allowed_mime_types=excluded.allowed_mime_types;

alter table public.admin_media enable row level security;

drop policy if exists "public can read active customer media" on public.admin_media;
create policy "public can read active customer media"
on public.admin_media
for select
using (is_active = true);
