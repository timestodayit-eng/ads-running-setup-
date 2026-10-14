-- Run once in your Supabase SQL Editor. Invite admin user in Auth > Users,
-- then insert that auth user UUID into staff table (see README).
create extension if not exists pgcrypto;
create table if not exists public.staff (
 id uuid primary key references auth.users(id) on delete cascade,
 role text not null default 'analyst' check(role in ('super_admin','ads_manager','analyst')),
 active boolean not null default true,
 created_at timestamptz not null default now()
);
create table if not exists public.ad_accounts (
 id uuid primary key default gen_random_uuid(), slot integer unique not null check(slot between 1 and 10),
 label text not null, meta_account_id text unique, meta_account_name text,
 daily_budget numeric(12,2) not null default 2500 check(daily_budget>=0),
 audience_note text not null default 'Bangladesh — configure eligible Meta targeting separately',
 phone text not null default '01958044480',
 start_date date not null default current_date,
 end_date date not null default (current_date+7),
 selected boolean not null default true,
 created_at timestamptz not null default now(),check(end_date>=start_date)
);
create table if not exists public.videos (
 id uuid primary key default gen_random_uuid(),name text not null,size_bytes bigint not null,
 mime_type text not null,object_key text not null,upload_id text,
 status text not null default 'uploading' check(status in ('uploading','ready','aborted')),
 uploaded_by uuid references auth.users(id),created_at timestamptz not null default now()
);
create table if not exists public.campaign_drafts (
 id uuid primary key default gen_random_uuid(), name text not null,objective text not null,
 special_ad_categories jsonb not null default '["EMPLOYMENT"]'::jsonb,
 video_id uuid not null references public.videos(id),caption text not null,headline text not null,
 items jsonb not null, status text not null default 'draft' check(status='draft'),
 created_by uuid references auth.users(id),created_at timestamptz not null default now()
);
create index if not exists idx_drafts_created on public.campaign_drafts(created_at desc);
create index if not exists idx_videos_created on public.videos(created_at desc);
insert into public.ad_accounts(slot,label) select i,'CI Ad Account '||lpad(i::text,2,'0') from generate_series(1,10) i on conflict(slot) do nothing;
-- Safety-in-depth: client-side keys cannot read company tables; backend checks staff and uses service role.
alter table public.staff enable row level security;
alter table public.ad_accounts enable row level security;
alter table public.videos enable row level security;
alter table public.campaign_drafts enable row level security;
