-- CEO: a second person with the same full access as the owner (role 'owner', shown as "מנכ"ל").
-- The main owner is protected: nobody else can change his role or deactivate him.
alter table public.profiles add column if not exists title text;
alter table public.profiles add column if not exists is_primary boolean not null default false;
update public.profiles set is_primary = true
where id = (select id from public.profiles where role = 'owner' and is_active order by created_at limit 1)
  and not exists (select 1 from public.profiles where is_primary);

create or replace function public.protect_primary_owner()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  if auth.uid() is not null and new.is_primary is distinct from old.is_primary then
    raise exception 'אי אפשר לשנות מי הבעלים הראשי';
  end if;
  if old.is_primary and auth.uid() is distinct from old.id
     and (new.role is distinct from old.role or new.is_active is distinct from old.is_active) then
    raise exception 'אי אפשר לשנות את ההרשאות של הבעלים הראשי';
  end if;
  return new;
end $function$;
create or replace trigger protect_primary_owner before update on public.profiles for each row execute function public.protect_primary_owner();
