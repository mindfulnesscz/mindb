-- assets.entities was created as TEXT and has been storing a JSON-encoded
-- array ('["ESS"]') while its siblings formats/angles/tags are real text[].
-- Both apps tolerate either shape (the portal runs values through
-- coerceArray(), the desktop sends arrays), so converting is safe and makes
-- Postgres-side filtering (cs./&&) and the GIN index possible at last.

-- ALTER COLUMN ... USING can't contain a subquery directly, so the JSON
-- unpacking lives in a throwaway helper function.
create function public._jsonish_to_text_array(v text)
returns text[] language sql immutable as $$
  select case
    when v is null or btrim(v) = ''  then '{}'::text[]
    when btrim(v) like '[%'          then array(select jsonb_array_elements_text(btrim(v)::jsonb))
    else array[v]  -- pre-JSON legacy rows held a bare value
  end;
$$;

alter table public.assets
  alter column entities drop default,
  alter column entities type text[] using public._jsonish_to_text_array(entities),
  alter column entities set default '{}',
  alter column entities set not null;

drop function public._jsonish_to_text_array(text);

-- Now that it's an array, the index the old schema file always claimed to have
create index if not exists assets_entities_gin on public.assets using gin (entities);
