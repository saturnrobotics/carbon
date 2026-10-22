-- service_images.py: extensions whose packaged default version moved with the
-- supabase/postgres image (15.14.1.112 -> 15.19.0.006: pg_net 0.20.0 -> 0.20.4,
-- vector 0.8.0 -> 0.8.2). ALTER EXTENSION ... UPDATE is a no-op at the default
-- version, so every maintenance run may apply this. pg_graphql 1.5.11 has no
-- update path to 1.6.2 and is not listed; Carbon does not install it.
DO $$
DECLARE
  extension text;
BEGIN
  FOREACH extension IN ARRAY ARRAY['pg_net', 'vector'] LOOP
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = extension) THEN
      EXECUTE format('ALTER EXTENSION %I UPDATE', extension);
    END IF;
  END LOOP;
END
$$;
