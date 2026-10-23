-- rollback of 1.20 (20261023_unavailable_not_failed.sql): the previous counters and finish rule.
-- The column campaigns.unavailable stays (harmless, nothing reads it after the web rollback).
create or replace function public.sync_campaign_counters() returns trigger
language plpgsql security definer set search_path = public as $$
declare c uuid := coalesce(new.campaign_id, old.campaign_id);
begin
  update public.campaigns set
    sent = (select count(*) from public.campaign_targets where campaign_id = c and status = 'sent'),
    failed = (select count(*) from public.campaign_targets where campaign_id = c and status = 'failed')
  where id = c;
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

  update public.campaign_targets t
  set status = 'failed', error = coalesce(t.error, 'אין זרוע פנויה: הזרועות שנבחרו לא בקבוצה, עצורות, נכשלו או הגיעו למגבלה')
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
