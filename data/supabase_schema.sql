-- KUBER cloud backup tables. Run once in your Supabase project's SQL editor.
-- Row-level security is on with no policies, so only the service-role key (kept on your Mac) can read or write.
create table if not exists kuber_daily (sym text, date text, open double precision, high double precision, low double precision, close double precision, adj double precision, volume double precision, primary key (sym, date));
create table if not exists kuber_ticks (sym text, ts bigint, price double precision, primary key (sym, ts));
create table if not exists kuber_rv (sym text, date text, n_ticks int, n_5m int, rv_5m double precision, rs_range double precision, overnight double precision, close double precision, model_vol double precision, primary key (sym, date));
create table if not exists kuber_preds (id text primary key, cid text, kind text, made text, "H" int, target text, p0 double precision, median double precision, p05 double precision, p25 double precision, p75 double precision, p95 double precision, "pUp" double precision, kappa double precision, params_ver int, actual double precision, actual_date text, scored text, pit double precision, in50 int, in90 int, "dirHit" int, err double precision, "logErr" double precision, iscore double precision);
create table if not exists kuber_analyses (id bigint primary key, cid text, ts text, px double precision, "H" int, median double precision, p05 double precision, p25 double precision, p75 double precision, p95 double precision, "pUp" double precision, mu double precision, vol double precision, score double precision, trigger text);
create table if not exists kuber_orders (id text primary key, date text, sym text, mk text default 'IN', name text, kind text, side text, qty double precision, price double precision, status text, note text, source text, created text);
create table if not exists kuber_sims (id text primary key, cid text, end_date text, status text, created text, data text);
create table if not exists kuber_notes (id text primary key, updated text, data text);
create table if not exists kuber_stock_models (cid text primary key, spec text, accepted int, metrics text, updated text);
create table if not exists kuber_calib (cid text primary key, kappa_adj double precision, mu_adj double precision, n int, epochs int, accepted int, metrics text, updated text);
create index if not exists kuber_ticks_ts on kuber_ticks (ts);
alter table kuber_daily enable row level security;
alter table kuber_ticks enable row level security;
alter table kuber_rv enable row level security;
alter table kuber_preds enable row level security;
alter table kuber_analyses enable row level security;
alter table kuber_orders enable row level security;
alter table kuber_sims enable row level security;
alter table kuber_notes enable row level security;
alter table kuber_stock_models enable row level security;
alter table kuber_calib enable row level security;

-- 90-day outlooks
create table if not exists kuber_ladder_runs (cid text, made text, p0 double precision, mu double precision, q double precision, vol double precision, signals text, weights text, kappa text, spec text, created text, primary key (cid, made));
create table if not exists kuber_ladder (cid text, made text, h int, p0 double precision, p05 double precision, p25 double precision, p50 double precision, p75 double precision, p95 double precision, "pUp" double precision, actual double precision, actual_date text, scored text, in50 int, in90 int, qscore double precision, primary key (cid, made, h));
alter table kuber_ladder_runs enable row level security;
alter table kuber_ladder enable row level security;
-- private storage bucket for archived intraday months (compressed CSV files)
insert into storage.buckets (id, name, public) values ('kuber-archive', 'kuber-archive', false) on conflict (id) do nothing;
-- KUBER uses only the service-role key. These grants make the tables reachable for it even when
-- "Automatically expose new tables" is off (recommended), while anon and signed-in users get nothing.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
revoke all on all tables in schema public from anon, authenticated;
