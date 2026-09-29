BEGIN;
-- Retain historical and in-flight GPT-5.6 reviews. New review admission uses GPT-6.
ALTER TABLE translation_reviews DROP CONSTRAINT translation_reviews_model_check;
ALTER TABLE translation_reviews ADD CONSTRAINT translation_reviews_model_check
  CHECK(model IN ('gpt-5.6-luna','gpt-6-luna'));
COMMIT;
