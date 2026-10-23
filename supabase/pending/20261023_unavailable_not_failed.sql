-- 23 Oct: a group whose arms are all disconnected / stopped / at their daily limit is not a failure.
-- Until now such a group was marked "failed" (red, "לא נשלחו") – on 22 Oct that was ~68,700 of ~135,000.
-- From now on it is "skipped" with the reason "אין זרוע זמינה", counted separately in campaigns.unavailable,
-- and the screens show "X groups available" instead of a red failure. A group where an arm really tried
-- and failed stays "failed". Additive: one new column, two functions replaced. Old rows are not changed.

alter table public.campaigns add column if not exists unavailable int not null default 0;

create or replace function public.sync_campaign_counters() returns trigger
language plpgsql security definer set search_path = public as $$
declare c uuid := coalesce(new.campaign_id, old.campaign_id); s int; f int; u int;
begin
  -- one pass over the ride's groups instead of one per counter
  select count(*) filter (where status = 'sent'),
         count(*) filter (where status = 'failed'),
         count(*) filter (where status = 'skipped' and error like 'אין זרוע זמינה%')
    into s, f, u
  from public.campaign_targets where campaign_id = c;
  update public.campaigns set sent = s, failed = f, unavailable = u where id = c;
  return null;
end $$;

create or replace function public.finalize_campaigns() returns void
language plpgsql security definer set search_path = public as $function$
begin
  update public.campaign_targets set status = 'failed',
    error = 'השליחה נקטעה ולא התקבל אישור – ייתכן שנשלחה. לא נשלחה שוב כדי למנוע כפילות'
  where status = 'sending' and claimed_at < now() - interval '5 minutes';

  update public.campaign_targets t set status = 'skipped',
    error = 'הנסיעה לא נשלחה לקבוצה הזו: עברו 15 דקות מפרסומה – לא נשלחת באיחור'
  from public.campaigns c
  where c.id = t.campaign_id and t.status = 'pending'
    and c.status in ('queued', 'running') and c.final_text is not null
    and c.kind <> 'manual' and c.created_at < now() - interval '15 minutes';

  update public.campaign_targets t set status = 'skipped',
    error = 'ההפצה נתקעה (אין זרוע מחוברת) ופג תוקפה – לא נשלחת באיחור'
  from public.campaigns c
  where c.id = t.campaign_id and t.status = 'pending'
    and c.status in ('queued', 'running') and c.final_text is not null and c.kind = 'manual'
    and coalesce(c.last_claim_at, c.created_at) < now() - interval '24 hours'
    and c.created_at < now() - interval '24 hours';

  -- no arm can send to this group: if an arm already tried and failed, it is a failure;
  -- if no arm ever tried (all disconnected / stopped / at the limit), the group was simply not available
  update public.campaign_targets t
  set status = case when t.error is null and coalesce(cardinality(t.tried_arms), 0) = 0 then 'skipped' else 'failed' end,
      error = coalesce(t.error, case when coalesce(cardinality(t.tried_arms), 0) = 0
                                     then 'אין זרוע זמינה בקבוצה הזו: הזרועות שבה לא מחוברות, עצורות או הגיעו למגבלה – לא נחשב כישלון'
                                     else 'אין זרוע פנויה: הזרועות שנבחרו לא בקבוצה, עצורות, נכשלו או הגיעו למגבלה' end)
  where t.status = 'pending'
    and exists (select 1 from public.campaigns c where c.id = t.campaign_id
                and c.status in ('queued', 'running') and c.final_text is not null)
    and not exists (
      select 1 from public.campaign_arms ca
      join public.arms a on a.id = ca.arm_id
      join public.groups g on g.arm_id = ca.arm_id and g.wa_group_id = t.wa_group_id
      left join public.app_settings s on s.station_id = a.station_id
      where ca.campaign_id = t.campaign_id and a.is_active
        and a.status not in ('error', 'qr', 'paused', 'pending')
        and not (a.status = 'offline' and coalesce(a.last_seen_at, a.created_at) < now() - interval '3 minutes')
        and not (a.sent_day = current_date and a.sent_today >= a.daily_limit)
        and not (ca.arm_id = any (t.tried_arms))
        and (coalesce(s.distribution_mode, 'fill') = 'fill' or
             (select count(*) from public.campaign_targets x
               where x.campaign_id = t.campaign_id and x.arm_id = ca.arm_id and x.status in ('sent', 'sending')) < coalesce(s.per_arm_group_limit, 60)));
  update public.campaigns c set status = 'completed', finished_at = now()
  where c.status in ('queued', 'running') and c.final_text is not null
    and not exists (select 1 from public.campaign_targets t
                    where t.campaign_id = c.id and t.status in ('pending', 'sending'));
end $function$;
