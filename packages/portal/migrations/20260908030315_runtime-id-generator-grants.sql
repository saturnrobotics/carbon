-- Runtime inserts use table defaults backed by Carbon's side-effect-free ID
-- generator. Grant only the write roles that own knowledge transactions.
GRANT EXECUTE ON FUNCTION public.id(text) TO knowledge_ingest,knowledge_review,knowledge_actions;
