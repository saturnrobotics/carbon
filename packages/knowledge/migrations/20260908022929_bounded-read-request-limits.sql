-- Nonbillable reads have independent durable admission limits; Redis loss does
-- not remove them. No prompt, source text, or credential enters these counters.
SET LOCAL ROLE knowledge_migrate;
CREATE TABLE knowledge_metering."requestPolicy" (
 "companyId" text NOT NULL REFERENCES public.company(id),
 endpoint text NOT NULL CHECK(endpoint IN ('knowledge.query','knowledge.entity')),
 "userPerMinute" integer NOT NULL CHECK("userPerMinute" BETWEEN 1 AND 10000),
 "companyPerMinute" integer NOT NULL CHECK("companyPerMinute" BETWEEN 1 AND 100000),
 PRIMARY KEY("companyId",endpoint)
);
CREATE TABLE knowledge_metering."requestWindow" (
 "companyId" text NOT NULL REFERENCES public.company(id),endpoint text NOT NULL,
 subject text NOT NULL,minute timestamptz NOT NULL,count integer NOT NULL CHECK(count>0),
 PRIMARY KEY("companyId",endpoint,subject,minute)
);
CREATE INDEX request_window_expiry ON knowledge_metering."requestWindow"(minute);
REVOKE ALL ON knowledge_metering."requestPolicy",knowledge_metering."requestWindow" FROM PUBLIC,anon,authenticated,knowledge_read,knowledge_ingest,knowledge_review,knowledge_actions;
CREATE FUNCTION knowledge_metering.admit_request(operation text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE company text:=knowledge.company_id(); actor text:=knowledge.actor_id();
 quota knowledge_metering."requestPolicy"%ROWTYPE; current_minute timestamptz:=date_trunc('minute',clock_timestamp());
 company_count integer; user_count integer;
BEGIN
 IF actor IS NULL OR NOT knowledge.actor_active(company) OR nullif(current_setting('knowledge.caller_id',true),'') IS NULL
 THEN RAISE EXCEPTION 'request authorization denied'; END IF;
 SELECT * INTO quota FROM knowledge_metering."requestPolicy" WHERE "companyId"=company AND endpoint=operation;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(company||':request:'||operation,0));
 SELECT COALESCE(max(count) FILTER(WHERE subject='company'),0),COALESCE(max(count) FILTER(WHERE subject='user:'||actor),0)
 INTO company_count,user_count FROM knowledge_metering."requestWindow"
 WHERE "companyId"=company AND endpoint=operation AND minute=current_minute AND subject IN ('company','user:'||actor);
 IF company_count>=quota."companyPerMinute" OR user_count>=quota."userPerMinute" THEN RETURN false; END IF;
 INSERT INTO knowledge_metering."requestWindow"("companyId",endpoint,subject,minute,count)
 VALUES(company,operation,'company',current_minute,1),(company,operation,'user:'||actor,current_minute,1)
 ON CONFLICT("companyId",endpoint,subject,minute) DO UPDATE SET count=knowledge_metering."requestWindow".count+1;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION knowledge_metering.admit_request(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION knowledge_metering.admit_request(text) TO knowledge_read;
