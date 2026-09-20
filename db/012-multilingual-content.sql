BEGIN;
-- Additive: legacy workers and English caches remain valid during rollout.
ALTER TABLE translation_jobs ADD COLUMN generation_request jsonb;
ALTER TABLE study_explanations ALTER COLUMN revision_id DROP NOT NULL;
ALTER TABLE study_explanations ADD COLUMN contract_version integer NOT NULL DEFAULT 1 CHECK(contract_version IN (1,2));
ALTER TABLE study_explanations ADD COLUMN explanation_language text NOT NULL DEFAULT 'en';
ALTER TABLE study_explanations ADD COLUMN study_text jsonb;
ALTER TABLE study_explanations ADD COLUMN selection_text_hash text;
ALTER TABLE study_explanations ADD COLUMN generation_request jsonb;
ALTER TABLE study_explanations ADD CHECK(contract_version=1 OR (study_text IS NOT NULL AND selection_text_hash IS NOT NULL AND generation_request IS NOT NULL));
COMMIT;
