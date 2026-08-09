-- Minimal staff resolution RPC for VetAI: lets an authenticated, same-clinic
-- staff member close one open staff_work_items row without granting direct
-- table UPDATE. Validated on disposable vetai-test on 2026-08-09; not
-- applied to production. See
-- docs/staff-workflow.md, docs/staff-work-items.md, and
-- docs/database-schema.md.

create function public.resolve_staff_work_item(p_work_item_id uuid)
returns table (result text)
language plpgsql
security definer
volatile
set search_path = ''
as $$
declare
  v_clinic_id uuid;
  v_status text;
begin
  if p_work_item_id is null then
    raise exception 'resolve_staff_work_item: invalid work_item_id';
  end if;

  select clinic_id, status
    into v_clinic_id, v_status
  from public.staff_work_items
  where id = p_work_item_id
  for update;

  -- No matching row and "row exists but caller isn't staff there" return the
  -- same not_found result so the RPC never reveals which case occurred.
  if v_clinic_id is null then
    return query select 'not_found'::text;
    return;
  end if;

  if not vetai_private.is_clinic_staff(v_clinic_id) then
    return query select 'not_found'::text;
    return;
  end if;

  if v_status = 'resolved' then
    return query select 'already_resolved'::text;
    return;
  end if;

  update public.staff_work_items
    set status = 'resolved', resolved_at = pg_catalog.now()
    where id = p_work_item_id;

  return query select 'resolved'::text;
  return;
end;
$$;

revoke all on function public.resolve_staff_work_item(uuid) from public, anon, service_role;
grant execute on function public.resolve_staff_work_item(uuid) to authenticated;
