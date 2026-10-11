-- No late rides: an automatic ride (help / quote) that is 15 minutes old is never sent any more,
-- even when a slow arm (e.g. a new number in its 24h warm-up, 6 msgs/min) is still sending it.
-- Before: the 20-minute expiry counted from the LAST claim, so a slow arm kept old rides alive for 40+ minutes.
-- Manual campaigns are unchanged (24 hours without progress).
create or replace function public.finalize_campaigns()
 returns void language plpgsql security definer set search_path to 'public'
as $function$
begin
  update public.campaign_targets set status = 'failed',
    error = 'השליחה נקטעה ולא התקבל אישור – ייתכן שנשלחה. לא נשלחה שוב כדי למנוע כפילות'
  where status = 'sending' and claimed_at < now() - interval '5 minutes';

  -- automatic rides: hard limit of 15 minutes from the moment the ride was published
  update public.campaign_targets t set status = 'skipped',
    error = 'הנסיעה לא נשלחה לקבוצה הזו: עברו 15 דקות מפרסומה – לא נשלחת באיחור'
  from public.campaigns c
  where c.id = t.campaign_id and t.status = 'pending'
    and c.status in ('queued', 'running') and c.final_text is not null
    and c.kind <> 'manual' and c.created_at < now() - interval '15 minutes';

  -- manual campaigns: 24 hours without progress
  update public.campaign_targets t set status = 'skipped',
    error = 'ההפצה נתקעה (אין זרוע מחוברת) ופג תוקפה – לא נשלחת באיחור'
  from public.campaigns c
  where c.id = t.campaign_id and t.status = 'pending'
    and c.status in ('queued', 'running') and c.final_text is not null and c.kind = 'manual'
    and coalesce(c.last_claim_at, c.created_at) < now() - interval '24 hours'
    and c.created_at < now() - interval '24 hours';

  -- a group only arms that cannot send can reach is closed now (an arm that reached its daily limit
  -- – e.g. stopped on purpose with limit 0 – no longer counts as available)
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
