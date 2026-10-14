-- 1.12 (15 Oct): the ✓ on a ride came only after 15 minutes when an arm in the ride's groups was not connected
-- but not marked as failed – 'pending' (waiting to be linked, e.g. אריה הפצה) or 'offline' for minutes.
-- The ride waited for it. Now such an arm counts as not available: its groups are closed as
-- 'אין זרוע פנויה' right away (as for blocked arms) and the ride finishes when everything else is sent.
-- An arm disconnected only a moment ago (offline, seen in the last 3 minutes) is still waited for.
CREATE OR REPLACE FUNCTION public.finalize_campaigns()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$
;
