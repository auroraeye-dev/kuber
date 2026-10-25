-- KUBER cloud collector: records live prices every minute in your Supabase project, so nothing is lost while the Mac
-- is asleep or off. KUBER on the Mac keeps the stock list here up to date and pulls in whatever it missed when it wakes.
-- Run once in the Supabase SQL Editor (it is safe to run again; it replaces the functions and the schedule).

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- (backup table change, 22 Oct 2026) orders now record their market: IN = rupees on NSE, US = dollars, KR = won
alter table if exists kuber_orders add column if not exists mk text default 'IN';

-- bond market backup (23 Oct 2026): official daily yields, India's zero curve and tenor-wise yields
create table if not exists kuber_bond_daily (series text, date text, y double precision, src text, primary key (series, date));
create table if not exists kuber_bond_nss (date text primary key, b0 double precision, b1 double precision, b2 double precision, b3 double precision, t1 double precision, t2 double precision, src text);
create table if not exists kuber_bond_sec (date text, bucket text, security text, ytm double precision, primary key (date, bucket));
-- official pages the cloud saves each evening (CCIL publishes only the last two days; RBI its current rates)
create table if not exists kuber_cloud_pages (name text, at timestamptz default now(), status int, content text, primary key (name, at));
alter table kuber_bond_daily enable row level security;
alter table kuber_bond_nss enable row level security;
alter table kuber_bond_sec enable row level security;
alter table kuber_cloud_pages enable row level security;
grant all on kuber_bond_daily, kuber_bond_nss, kuber_bond_sec, kuber_cloud_pages to service_role;
revoke all on kuber_bond_daily, kuber_bond_nss, kuber_bond_sec, kuber_cloud_pages from anon, authenticated;

-- stocks to record (maintained by KUBER on the Mac)
create table if not exists kuber_cloud_symbols (sym text primary key, path text not null, mk text not null, active boolean not null default true, updated timestamptz default now());
-- prices recorded in the cloud (kept 30 days; the Mac keeps the long-term copy)
create table if not exists kuber_cloud_ticks (sym text, ts bigint, price double precision, collected_at timestamptz default now(), primary key (sym, ts));
create index if not exists kuber_cloud_ticks_ts on kuber_cloud_ticks (ts);
-- requests in flight, and a short run log
create table if not exists kuber_cloud_pending (request_id bigint primary key, sym text, mk text, test boolean default false, created timestamptz default now());
create table if not exists kuber_cloud_log (at timestamptz primary key default now(), stored int, failed int, requested int);

alter table kuber_cloud_symbols enable row level security;
alter table kuber_cloud_ticks enable row level security;
alter table kuber_cloud_pending enable row level security;
alter table kuber_cloud_log enable row level security;
grant all on kuber_cloud_symbols, kuber_cloud_ticks, kuber_cloud_pending, kuber_cloud_log to service_role;
revoke all on kuber_cloud_symbols, kuber_cloud_ticks, kuber_cloud_pending, kuber_cloud_log from anon, authenticated;

-- is this exchange in its trading session right now? (weekends excluded; exchange holidays are not known)
create or replace function kuber_session_open(mk text) returns boolean language sql stable as $$
  select case mk
    when 'IN' then extract(isodow from now() at time zone 'Asia/Kolkata') between 1 and 5 and (now() at time zone 'Asia/Kolkata')::time between '09:15' and '15:30'
    when 'KR' then extract(isodow from now() at time zone 'Asia/Seoul') between 1 and 5 and (now() at time zone 'Asia/Seoul')::time between '09:00' and '15:30'
    else extract(isodow from now() at time zone 'America/New_York') between 1 and 5 and (now() at time zone 'America/New_York')::time between '09:30' and '16:00'
  end $$;

-- bond hours worth recording in the cloud: US Treasuries 07:00–17:30 New York, Indian G-secs 09:00–17:00 IST (weekdays)
create or replace function kuber_bond_hours() returns boolean language sql stable as $$
  select (extract(isodow from now() at time zone 'America/New_York') between 1 and 5 and (now() at time zone 'America/New_York')::time between '07:00' and '17:30')
      or (extract(isodow from now() at time zone 'Asia/Kolkata') between 1 and 5 and (now() at time zone 'Asia/Kolkata')::time between '09:00' and '17:00') $$;

-- parse a timestamp safely (a format change at the source must never stop the stock collector)
create or replace function kuber_try_ts(t text) returns timestamptz language plpgsql immutable as $$
begin return t::timestamptz; exception when others then return null; end $$;

-- parse JSON safely (a blocked request returns HTML, which must not stop the run)
create or replace function kuber_try_json(t text) returns jsonb language plpgsql immutable as $$
begin return t::jsonb; exception when others then return null; end $$;

-- every minute: store the answers to the previous minute's requests, then ask for the stocks whose market is open
create or replace function kuber_collect() returns int language plpgsql security definer set search_path = public, extensions as $$
declare stored int := 0; failed int := 0; requested int := 0;
begin
  with done as (
    select p.sym, p.mk, kuber_try_json(r.content) -> 'data' as d, r.status_code
    from kuber_cloud_pending p join net._http_response r on r.id = p.request_id where not p.test
  ), ins as (
    insert into kuber_cloud_ticks (sym, ts, price)
    select sym, floor((d ->> 'ts')::numeric / 1000)::bigint, (d ->> 'p')::double precision from done
    where status_code = 200 and d is not null and (d ->> 'p') is not null and (d ->> 'ts') is not null
      and abs(extract(epoch from now()) - (d ->> 'ts')::numeric / 1000) < 2700        -- quote at most 45 min old (ts can carry decimals)
    on conflict do nothing returning 1
  ) select count(*) into stored from ins;
  -- bond yields (one request for all series): stored as sym 'B:US10Y' etc., quotes at most 15 minutes old
  with q as (
    select jsonb_array_elements(case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end) as e
    from (select kuber_try_json(r.content) -> 'FormattedQuoteResult' -> 'FormattedQuote' as j
          from kuber_cloud_pending p join net._http_response r on r.id = p.request_id where p.mk = 'BOND' and not p.test and r.status_code = 200) x
  ), insb as (
    insert into kuber_cloud_ticks (sym, ts, price)
    select 'B:' || (e ->> 'symbol'), floor(extract(epoch from kuber_try_ts(e ->> 'last_time')))::bigint, replace(e ->> 'last', '%', '')::double precision from q
    where (e ->> 'last') ~ '^-?[0-9]+(\.[0-9]+)?%?$' and kuber_try_ts(e ->> 'last_time') is not null
      and abs(extract(epoch from now()) - extract(epoch from kuber_try_ts(e ->> 'last_time'))) < 900
    on conflict do nothing returning 1
  ) select stored + count(*) into stored from insb;
  -- official pages requested by kuber_fetch_pages()
  insert into kuber_cloud_pages (name, at, status, content)
  select p.sym, now(), r.status_code, r.content from kuber_cloud_pending p join net._http_response r on r.id = p.request_id where p.mk = 'PAGE' and not p.test;
  select count(*) into failed from kuber_cloud_pending p join net._http_response r on r.id = p.request_id where not p.test and (r.status_code is distinct from 200 or r.timed_out);
  delete from kuber_cloud_pending p using net._http_response r where r.id = p.request_id and not p.test;
  delete from kuber_cloud_pending where created < now() - interval '15 minutes';

  insert into kuber_cloud_pending (request_id, sym, mk)
  select net.http_get(
           url := 'https://stockanalysis.com/api/quotes/' || s.path,
           headers := jsonb_build_object('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept', 'application/json'),
           timeout_milliseconds := 20000),
         s.sym, s.mk
  from kuber_cloud_symbols s where s.active and kuber_session_open(s.mk);
  get diagnostics requested = row_count;
  if kuber_bond_hours() then
    insert into kuber_cloud_pending (request_id, sym, mk)
    select net.http_get(url := 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=US1M%7CUS3M%7CUS6M%7CUS1Y%7CUS2Y%7CUS3Y%7CUS5Y%7CUS7Y%7CUS10Y%7CUS20Y%7CUS30Y%7CIN10Y%7CIN30Y&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json',
             headers := jsonb_build_object('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept', 'application/json'),
             timeout_milliseconds := 20000), 'BONDS', 'BOND';
    requested := requested + 1;
  end if;

  if requested > 0 or stored > 0 or failed > 0 then insert into kuber_cloud_log (at, stored, failed, requested) values (now(), stored, failed, requested); end if;
  return stored;
end $$;

-- evening: save the official India pages (CCIL zero curve and tenor-wise yields; RBI policy rates)
create or replace function kuber_fetch_pages() returns int language plpgsql security definer set search_path = public, extensions as $$
declare n int; begin
  insert into kuber_cloud_pending (request_id, sym, mk)
  select net.http_get(url := u.url, headers := jsonb_build_object('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept', 'text/html'), timeout_milliseconds := 30000), u.name, 'PAGE'
  from (values ('ccil-zcyc', 'https://www.ccilindia.com/zcyc-parameters'), ('ccil-tenor', 'https://www.ccilindia.com/tenorwise-indicative-yields'), ('rbi', 'https://www.rbi.org.in/')) as u(name, url);
  get diagnostics n = row_count; return n; end $$;

-- test helpers (used by KUBER to check that the source answers the cloud): fire one request per stock now,
-- then read the answers a few seconds later. Test rows are never stored as prices.
create or replace function kuber_cloud_probe() returns int language plpgsql security definer set search_path = public, extensions as $$
declare n int; begin
  insert into kuber_cloud_pending (request_id, sym, mk, test)
  select net.http_get(url := 'https://stockanalysis.com/api/quotes/' || s.path,
           headers := jsonb_build_object('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept', 'application/json'),
           timeout_milliseconds := 20000), s.sym, s.mk, true
  from kuber_cloud_symbols s where s.active;
  get diagnostics n = row_count; return n; end $$;
create or replace function kuber_cloud_probe_result() returns table (sym text, status int, price double precision, quote_ts bigint, error text) language plpgsql security definer set search_path = public, extensions as $$
begin
  return query select p.sym, r.status_code, (kuber_try_json(r.content) -> 'data' ->> 'p')::double precision, floor((kuber_try_json(r.content) -> 'data' ->> 'ts')::numeric / 1000)::bigint, r.error_msg
    from kuber_cloud_pending p left join net._http_response r on r.id = p.request_id where p.test;
  delete from kuber_cloud_pending p where p.test and exists (select 1 from net._http_response r where r.id = p.request_id);
end $$;

revoke all on function kuber_collect(), kuber_cloud_probe(), kuber_cloud_probe_result(), kuber_fetch_pages() from public, anon, authenticated;
grant execute on function kuber_collect(), kuber_cloud_probe(), kuber_cloud_probe_result(), kuber_fetch_pages() to service_role;

-- the schedule: every minute, plus a daily clean-up of prices older than 30 days and logs older than 7 days
select cron.unschedule(jobid) from cron.job where jobname in ('kuber-collect', 'kuber-cloud-prune', 'kuber-pages-evening', 'kuber-pages-late', 'kuber-pages-morning');
select cron.schedule('kuber-collect', '* * * * *', $$select public.kuber_collect()$$);
select cron.schedule('kuber-cloud-prune', '17 3 * * *', $$delete from public.kuber_cloud_ticks where collected_at < now() - interval '30 days'; delete from public.kuber_cloud_log where at < now() - interval '7 days'; delete from public.kuber_cloud_pages where at < now() - interval '21 days'$$);
-- India pages: 19:45 and 21:15 IST on weekdays (CCIL publishes in the evening), and 08:00 IST the next morning
select cron.schedule('kuber-pages-evening', '15 14 * * 1-5', $$select public.kuber_fetch_pages()$$);
select cron.schedule('kuber-pages-late', '45 15 * * 1-5', $$select public.kuber_fetch_pages()$$);
select cron.schedule('kuber-pages-morning', '30 2 * * 2-6', $$select public.kuber_fetch_pages()$$);
