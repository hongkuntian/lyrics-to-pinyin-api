BEGIN;
ALTER TABLE library_settings ADD COLUMN review_publication_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE correction_batches ADD COLUMN stage text NOT NULL DEFAULT 'assessment' CHECK(stage IN ('assessment','verification'));
ALTER TABLE correction_batches ADD COLUMN policy_version text NOT NULL DEFAULT 'song-review-assessment-1';
ALTER TABLE correction_batches ADD UNIQUE(id,stage);
ALTER TABLE correction_batch_items ADD COLUMN stage text NOT NULL DEFAULT 'assessment' CHECK(stage IN ('assessment','verification'));
ALTER TABLE correction_batch_items ADD COLUMN comparison_context jsonb;
ALTER TABLE correction_batch_items DROP CONSTRAINT correction_batch_items_review_id_key;
ALTER TABLE correction_batch_items DROP CONSTRAINT correction_batch_items_revision_id_key;
ALTER TABLE correction_batch_items ADD UNIQUE(review_id,stage);
ALTER TABLE correction_batch_items ADD UNIQUE(revision_id,stage);
ALTER TABLE correction_batch_items ADD FOREIGN KEY(batch_id,stage) REFERENCES correction_batches(id,stage);
ALTER TABLE correction_batch_items ADD CHECK((stage='verification')=(comparison_context IS NOT NULL));
CREATE FUNCTION library_check_review_item() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM library_spend_operations o JOIN translation_reviews r ON r.id=o.review_id
    WHERE o.id=NEW.operation_id AND o.review_id=NEW.review_id AND r.revision_id=NEW.revision_id
      AND o.kind=CASE WHEN NEW.stage='assessment' THEN 'review_assessment' ELSE 'review_verification' END) THEN
    RAISE EXCEPTION 'review_operation_mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER library_check_review_item BEFORE INSERT ON correction_batch_items FOR EACH ROW EXECUTE FUNCTION library_check_review_item();

ALTER TABLE correction_review_queue DROP CONSTRAINT correction_review_queue_state_check;
ALTER TABLE correction_review_queue ADD CHECK(state IN ('pending','reserved','submitted','assessed','blocked','superseded','kept','deferred','published'));
CREATE TABLE correction_review_outcomes (
  review_id uuid PRIMARY KEY REFERENCES translation_reviews(id),
  disposition text NOT NULL CHECK(disposition IN ('kept','deferred','published','superseded','blocked')),
  policy_version text NOT NULL,
  reason text NOT NULL,
  candidate_hash text,
  comparison_hash text,
  published_revision_id uuid UNIQUE REFERENCES translation_revisions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((disposition='published')=(published_revision_id IS NOT NULL))
);
CREATE FUNCTION library_immutable_review_outcome() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'review_outcome_immutable';
END $$;
CREATE TRIGGER library_immutable_review_outcome BEFORE UPDATE OR DELETE ON correction_review_outcomes FOR EACH ROW EXECUTE FUNCTION library_immutable_review_outcome();
REVOKE ALL ON correction_review_outcomes FROM PUBLIC;
COMMIT;
