-- Operational accounting is isolated from source/index tables. Read processes
-- can invoke only these bounded functions; they cannot edit quotas or ledger rows.
CREATE SCHEMA IF NOT EXISTS knowledge_metering AUTHORIZATION knowledge_migrate;
REVOKE ALL ON SCHEMA knowledge_metering FROM PUBLIC,anon,authenticated;
SET LOCAL ROLE knowledge_migrate;
CREATE TABLE knowledge_metering.policy (
 "companyId" text NOT NULL REFERENCES public.company(id),endpoint text NOT NULL CHECK(length(endpoint) BETWEEN 1 AND 100),
 "companyTokens" bigint NOT NULL CHECK("companyTokens">0),"userTokens" bigint NOT NULL CHECK("userTokens">0),
 "companyMicroUsd" bigint NOT NULL CHECK("companyMicroUsd">0),"userMicroUsd" bigint NOT NULL CHECK("userMicroUsd">0),
 "requestsPerMinute" integer NOT NULL CHECK("requestsPerMinute" BETWEEN 1 AND 10000),
 "concurrencyLimit" integer NOT NULL CHECK("concurrencyLimit" BETWEEN 1 AND 1000),PRIMARY KEY("companyId",endpoint)
);
CREATE TABLE knowledge_metering.reservation (
 "companyId" text NOT NULL REFERENCES public.company(id),"actorId" text NOT NULL REFERENCES public."user"(id),
 endpoint text NOT NULL,"requestId" text NOT NULL CHECK(length("requestId") BETWEEN 1 AND 256),
 "payloadHash" text NOT NULL CHECK("payloadHash" ~ '^[0-9a-f]{64}$'),
 "reservedTokens" bigint NOT NULL CHECK("reservedTokens">0),"reservedMicroUsd" bigint NOT NULL CHECK("reservedMicroUsd">0),
 "actualTokens" bigint CHECK("actualTokens">=0 AND "actualTokens"<="reservedTokens"),
 "actualMicroUsd" bigint CHECK("actualMicroUsd">=0 AND "actualMicroUsd"<="reservedMicroUsd"),
 "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),"settledAt" timestamptz,
 PRIMARY KEY("companyId","actorId",endpoint,"requestId")
);
CREATE INDEX reservation_daily ON knowledge_metering.reservation("companyId",endpoint,"createdAt");
REVOKE ALL ON ALL TABLES IN SCHEMA knowledge_metering FROM PUBLIC,anon,authenticated,knowledge_read,knowledge_actions,knowledge_review,knowledge_ingest;

CREATE FUNCTION knowledge_metering.reserve(operation text,request_id text,payload_hash text,tokens bigint,micro_usd bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE company text := knowledge.company_id(); actor text := knowledge.actor_id(); quota knowledge_metering.policy%ROWTYPE;
 previous knowledge_metering.reservation%ROWTYPE; total_tokens numeric; user_tokens numeric; total_spend numeric; user_spend numeric;
 requests bigint; active_requests bigint; day_start timestamptz := date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
BEGIN
 IF NOT knowledge.actor_active(company) OR actor IS NULL OR nullif(current_setting('knowledge.caller_id',true),'') IS NULL THEN RAISE EXCEPTION 'budget authorization denied'; END IF;
 IF tokens IS NULL OR tokens<1 OR tokens>1000000 OR micro_usd IS NULL OR micro_usd<1 OR micro_usd>1000000000 OR length(request_id) NOT BETWEEN 1 AND 256 OR payload_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid reservation'; END IF;
 -- One company/endpoint lock serializes the aggregate check and reservation.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(company||':'||operation,714204));
 SELECT * INTO quota FROM knowledge_metering.policy WHERE "companyId"=company AND endpoint=operation;
 IF NOT FOUND THEN RAISE EXCEPTION 'budget policy unavailable'; END IF;
 SELECT * INTO previous FROM knowledge_metering.reservation WHERE "companyId"=company AND "actorId"=actor AND endpoint=operation AND "requestId"=request_id;
 IF FOUND THEN
  IF previous."payloadHash"<>payload_hash OR previous."reservedTokens"<>tokens OR previous."reservedMicroUsd"<>micro_usd THEN RAISE EXCEPTION 'reservation conflict'; END IF;
  -- A retried reservation must never start another provider call. The caller must
  -- use its completed result or report in-progress/unknown, not infer again.
  RETURN jsonb_build_object('acquired',false,'settled',previous."settledAt" IS NOT NULL);
 END IF;
 SELECT COALESCE(sum(COALESCE("actualTokens","reservedTokens")),0),
 COALESCE(sum(COALESCE("actualTokens","reservedTokens")) FILTER(WHERE "actorId"=actor),0),
 COALESCE(sum(COALESCE("actualMicroUsd","reservedMicroUsd")),0),
 COALESCE(sum(COALESCE("actualMicroUsd","reservedMicroUsd")) FILTER(WHERE "actorId"=actor),0),
 count(*) FILTER(WHERE "actorId"=actor AND "createdAt">clock_timestamp()-interval '1 minute'),
 count(*) FILTER(WHERE "settledAt" IS NULL AND "createdAt">clock_timestamp()-interval '60 seconds')
 INTO total_tokens,user_tokens,total_spend,user_spend,requests,active_requests
 FROM knowledge_metering.reservation WHERE "companyId"=company AND endpoint=operation AND "createdAt">=day_start;
 IF total_tokens+tokens>quota."companyTokens" OR user_tokens+tokens>quota."userTokens" OR total_spend+micro_usd>quota."companyMicroUsd" OR user_spend+micro_usd>quota."userMicroUsd" OR requests>=quota."requestsPerMinute" OR active_requests>=quota."concurrencyLimit" THEN RAISE EXCEPTION 'budget exhausted'; END IF;
 INSERT INTO knowledge_metering.reservation("companyId","actorId",endpoint,"requestId","payloadHash","reservedTokens","reservedMicroUsd") VALUES(company,actor,operation,request_id,payload_hash,tokens,micro_usd);
 RETURN jsonb_build_object('acquired',true,'settled',false);
END $$;

CREATE FUNCTION knowledge_metering.settle(operation text,request_id text,tokens bigint,micro_usd bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE company text:=knowledge.company_id(); actor text:=knowledge.actor_id(); previous knowledge_metering.reservation%ROWTYPE;
BEGIN
 IF NOT knowledge.actor_active(company) OR actor IS NULL THEN RAISE EXCEPTION 'budget authorization denied'; END IF;
 SELECT * INTO previous FROM knowledge_metering.reservation WHERE "companyId"=company AND "actorId"=actor AND endpoint=operation AND "requestId"=request_id FOR UPDATE;
 IF NOT FOUND OR tokens IS NULL OR micro_usd IS NULL OR tokens<0 OR micro_usd<0 OR tokens>previous."reservedTokens" OR micro_usd>previous."reservedMicroUsd" THEN RAISE EXCEPTION 'invalid settlement'; END IF;
 IF previous."settledAt" IS NOT NULL THEN
  IF previous."actualTokens"<>tokens OR previous."actualMicroUsd"<>micro_usd THEN RAISE EXCEPTION 'settlement conflict'; END IF;
  RETURN;
 END IF;
 UPDATE knowledge_metering.reservation SET "actualTokens"=tokens,"actualMicroUsd"=micro_usd,"settledAt"=clock_timestamp() WHERE "companyId"=company AND "actorId"=actor AND endpoint=operation AND "requestId"=request_id;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA knowledge_metering FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA knowledge_metering TO knowledge_read,knowledge_actions,knowledge_review,knowledge_ingest;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA knowledge_metering TO knowledge_read,knowledge_actions,knowledge_review,knowledge_ingest;
RESET ROLE;
