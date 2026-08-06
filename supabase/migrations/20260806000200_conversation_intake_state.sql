-- Persisted conversation intake state for VetAI.
-- Validated in the disposable `vetai-test` project with
-- supabase/tests/006_conversation_intake_state.sql.
-- Production must apply this file through the managed Supabase migration
-- workflow.

alter table public.conversations
  add column intake_stage text not null default 'pet_identification'
    check (intake_stage in (
      'pet_identification',
      'complaint_collection',
      'safety_check',
      'ready_for_triage',
      'appointment_offer',
      'appointment_selection',
      'appointment_confirmation',
      'human_handoff',
      'completed'
    )),
  add column intake_data jsonb not null default '{}'::jsonb
    check (jsonb_typeof(intake_data) = 'object'),
  add column state_version integer not null default 1
    check (state_version > 0);

-- Context read RPC: one row for an existing conversation, scoped strictly to
-- that conversation's own owner and clinic. Never returns phone numbers,
-- WhatsApp ids, or webhook hashes.
create function public.get_conversation_intake_context(p_conversation_id uuid)
returns table (
  conversation_id uuid,
  clinic_id uuid,
  owner_id uuid,
  pet_id uuid,
  status text,
  intake_stage text,
  intake_data jsonb,
  state_version integer,
  owner_name text,
  pets jsonb,
  recent_messages jsonb
)
language plpgsql
security invoker
stable
set search_path = ''
as $$
begin
  return query
  select
    c.id,
    c.clinic_id,
    c.owner_id,
    c.pet_id,
    c.status,
    c.intake_stage,
    c.intake_data,
    c.state_version,
    o.full_name,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object('id', p.id, 'name', p.name, 'species', p.species)
          order by p.created_at, p.id
        )
        from public.pets p
        where p.owner_id = c.owner_id and p.clinic_id = c.clinic_id
      ),
      '[]'::jsonb
    ),
    coalesce(
      (
        select jsonb_agg(recent.item order by recent.created_at, recent.id)
        from (
          select
            jsonb_build_object('direction', m.direction, 'content', m.content, 'created_at', m.created_at) as item,
            m.created_at,
            m.id
          from public.messages m
          where m.conversation_id = c.id and m.clinic_id = c.clinic_id
          order by m.created_at desc, m.id desc
          limit 12
        ) recent
      ),
      '[]'::jsonb
    )
  from public.conversations c
  join public.owners o on o.id = c.owner_id and o.clinic_id = c.clinic_id
  where c.id = p_conversation_id;
end;
$$;

revoke all on function public.get_conversation_intake_context(uuid)
  from public, anon, authenticated;
grant execute on function public.get_conversation_intake_context(uuid)
  to service_role;

-- State advance RPC: optimistic-concurrency, forward-only stage transitions.
-- ponytail: the forward graph is a fixed jsonb rank map, not a table, since
-- the sequence is closed for this task; promote to a table only if a future
-- task needs to configure it per clinic.
create function public.advance_conversation_intake(
  p_conversation_id uuid,
  p_expected_version integer,
  p_next_stage text,
  p_pet_id uuid,
  p_intake_data jsonb
)
returns table (
  intake_stage text,
  state_version integer
)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_clinic_id uuid;
  v_owner_id uuid;
  v_current_stage text;
  v_current_status text;
  v_next_status text;
  v_updated_stage text;
  v_updated_version integer;
  v_stage_rank constant jsonb := '{
    "pet_identification": 0,
    "complaint_collection": 1,
    "safety_check": 2,
    "ready_for_triage": 3,
    "appointment_offer": 4,
    "appointment_selection": 5,
    "appointment_confirmation": 6,
    "completed": 7
  }'::jsonb;
begin
  if p_conversation_id is null then
    raise exception 'advance_conversation_intake: invalid conversation_id';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'advance_conversation_intake: invalid expected_version';
  end if;
  if p_next_stage is null or not (v_stage_rank ? p_next_stage) and p_next_stage <> 'human_handoff' then
    raise exception 'advance_conversation_intake: invalid next_stage';
  end if;
  if p_intake_data is null
    or jsonb_typeof(p_intake_data) <> 'object'
    or p_intake_data = '{}'::jsonb then
    raise exception 'advance_conversation_intake: invalid intake_data';
  end if;

  select c.clinic_id, c.owner_id, c.intake_stage, c.status
    into v_clinic_id, v_owner_id, v_current_stage, v_current_status
  from public.conversations c
  where c.id = p_conversation_id;

  if v_clinic_id is null then
    raise exception 'advance_conversation_intake: unknown conversation_id';
  end if;

  if p_pet_id is not null and not exists (
    select 1 from public.pets p
    where p.id = p_pet_id and p.owner_id = v_owner_id and p.clinic_id = v_clinic_id
  ) then
    raise exception 'advance_conversation_intake: pet does not belong to the conversation owner/clinic';
  end if;

  if p_next_stage <> v_current_stage then
    if v_current_stage in ('human_handoff', 'completed') then
      raise exception 'advance_conversation_intake: % is terminal', v_current_stage;
    elsif p_next_stage = 'human_handoff' then
      null; -- any non-terminal stage may hand off
    elsif (v_stage_rank -> p_next_stage)::integer = (v_stage_rank -> v_current_stage)::integer + 1 then
      null; -- exactly one forward step in the fixed graph
    else
      raise exception 'advance_conversation_intake: illegal transition from % to %', v_current_stage, p_next_stage;
    end if;
  end if;

  v_next_status := v_current_status;
  if p_next_stage = 'human_handoff' then
    v_next_status := 'handoff';
  elsif p_next_stage = 'completed' then
    v_next_status := 'completed';
  end if;

  update public.conversations c
    set intake_stage = p_next_stage,
        intake_data = p_intake_data,
        pet_id = coalesce(p_pet_id, c.pet_id),
        state_version = c.state_version + 1,
        status = v_next_status
    where c.id = p_conversation_id
      and c.state_version = p_expected_version
  returning c.intake_stage, c.state_version into v_updated_stage, v_updated_version;

  if not found then
    return;
  end if;

  intake_stage := v_updated_stage;
  state_version := v_updated_version;
  return next;
end;
$$;

revoke all on function public.advance_conversation_intake(uuid, integer, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.advance_conversation_intake(uuid, integer, text, uuid, jsonb)
  to service_role;
